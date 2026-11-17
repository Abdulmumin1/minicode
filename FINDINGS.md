# Brief independent investigation of code mode sandboxes: OpenCode, Rivet's secure-exec, node:vm, and one I built

I recently published a post on what I learned from this investigation. You can read [the full post here](https://yaqeen.me/blog/i-built-a-code-mode-sandbox).

Here is the short version of what I found, in the order I found it:

> I probed OpenCode's `execute` tool from the inside, read the source of OpenCode's interpreter and Rivet's secure-exec, and built a small runtime of my own. All four take different positions on where the wall goes. The most useful thing I found was a gap in the limits, not in the walls.
>
> ![](https://yaqeen.me/blog/i-built-a-code-mode-sandbox/03-three-ways.png)
>
> OpenCode's `execute` is not a JavaScript engine. `globalThis` failed with "Unknown identifier", and a class failed with "This is a restricted JavaScript-like language." In the source it is `@opencode/codemode`: acorn, a compiler to bytecode, and a VM of about 3,100 lines.
>
> The VM is cooperative. It runs for about 1 ms (10,000 steps of fuel), then yields to the host. That is why a busy loop can't freeze the host. Recursion stops at 10,000. A program awaiting something that can never settle fails at once with "Stuck", instead of waiting for a timeout.
>
> OpenCode's `execute` tool turns on no limits: no timeout, no tool-call cap, no output cap. The package caps single operations (strings at 2^24 characters, arrays at 10M elements), but has no total memory limit.
>
> In its own process, with a 20 second timeout, OpenCode's interpreter grew to 2.9 GB on a program that pushes megabyte strings into an array. Two probes I ran inside `execute` ended with OpenCode's server restarting. I believe this is why, but I didn't watch the server's memory at the time.
>
> ![](https://yaqeen.me/blog/i-built-a-code-mode-sandbox/playground-memory-bomb.png)
>
> Rivet's secure-exec takes the opposite position: real V8 isolates (rusty_v8 130) in a Rust sidecar process, behind a virtual kernel for `fs`, `net` and `child_process`. Each isolate gets a 128 MB heap, a separate ArrayBuffer budget, and a CPU-time budget read from the thread's own clock.
>
> Some of secure-exec's claims don't match its repo. The landing page says 17.9 ms cold start and 3.4 MB per instance; its own docs report 13.7 to 40.7 ms, and about 20 MiB per warm isolate. The page says both "no sidecar" and "sidecar process separate from yours". The code has a sidecar.
>
> My first sandbox used `node:vm` in a worker. `globalThis.constructor.constructor("return process")()` reached the real `process` on the first try. Node 22's `DONT_CONTEXTIFY` closed that path.
>
> ![](https://yaqeen.me/blog/i-built-a-code-mode-sandbox/02-node-vm-escape.png)
>
> My second, minicode, is an interpreter like OpenCode's: acorn, then a tree-walker built from generators, with a driver that yields every 1 ms. Unsupported syntax is refused before anything runs, so no tool fires for a program that was always going to fail.
>
> ![](https://yaqeen.me/blog/i-built-a-code-mode-sandbox/04-how-minicode-runs.png)
>
> minicode leaked a host value through its own method tables. `({}).constructor` returned the host's real `Object`, because the tables were plain objects. Guest code couldn't call it, but it should never have got in. The fix was `Object.create(null)`, and the test now fails if the bug comes back.
>
> ![](https://yaqeen.me/blog/i-built-a-code-mode-sandbox/06-method-table-leak.png)
>
> Each guest call in minicode costs about 1.8 KB of host stack, so recursion first stopped at 172 levels. Removing one generator frame per call got it to about 550. Fixing it properly would take a VM with its own stack, which is what OpenCode built.
>
> Two optimizations made minicode 5 times faster on tight loops: a synchronous path for expressions that can't call, pause or await, and copying `let` loop variables only when a closure could capture them. It is still about 4 times slower than OpenCode's VM on loops, and faster on JSON.
>
> ![](https://yaqeen.me/blog/i-built-a-code-mode-sandbox/07-benchmarks.png)
>
> Calls that weren't awaited showed two timing bugs. Host work started a microtask late, so a tool could begin after the run had ended. Then an instant tool was labelled "interrupted" even though it had run. Both are fixed and tested.
>
> minicode turns its limits on by default: 30 s, 100 tool calls, 64 KB of output, 256 MB of heap growth. It stops the same memory bomb in 0.65 s at 338 MB.
>
> [The notes below](#notes) have much more than I could fit here, including the evidence behind each finding, how to reproduce it, and the full benchmark table.

Virtually all of this was measured on one Apple Silicon MacBook, with Node 22.21.1 and Bun 1.3.3, against OpenCode at commit `db1d7b91` (2026-11-17) and Rivet's agentOS at `e57c6aa3` (2026-11-13). Both projects move quickly, and some of this may already be out of date.

I scoped this brief investigation to how each runtime keeps guest code in, and what it does when guest code misbehaves. Everything else was out of scope, including formal security review of any of them, the security of the tools they call, and whether their models write good programs. minicode itself has had no review beyond mine, and it is for learning.

Both projects publish their own documentation. I didn't confirm their marketing claims beyond what I note above.

Nobody paid for this, and I don't work for OpenCode or Rivet.

I thank the OpenCode and Rivet teams for building in the open, under the MIT and Apache 2.0 licenses. Being able to read the source of two serious answers to the same question is what made this possible.

---

# Notes

Each note says how I know it: **measured** (I ran it), **read** (in source code), or **claimed** (someone's docs or marketing, not checked).

## Part 1: Probing OpenCode's `execute` tool from the inside

OpenCode gives its model a tool called `execute`. The model writes JavaScript that
calls `tools.<namespace>.<name>(input)`. I was running inside it, so I probed it.

**F1. It isn't a JavaScript engine. It's a custom interpreter.** (measured)
`globalThis` failed with `ReferenceError: Unknown identifier 'globalThis'`.
`class A {}` failed with *"This is a restricted JavaScript-like language. Supported:
plain and async functions, data literals, destructuring ... Unsupported: classes,
getters/setters, BigInt, and custom Symbols."* `new Function(...)` gave *"The Function
constructor is not supported; write the function inline."* No real engine says these.

**F2. What works.** (measured) Generators, destructuring, spread, optional chaining,
tagged templates, regex with named groups, labels, closures with per-iteration `let`,
`this` in methods, Map/Set, JSON, Intl number formatting, `typeof Uint8Array`.
Missing: classes, getters, BigInt, custom Symbols, `Object.defineProperty`,
`setTimeout`, `eval`, `Proxy`.

**F3. Tool references are their own kind of value.** (measured) `String(tools.x.y)` is
`[object Object]`, and `Object.getPrototypeOf(tools)` says *"cannot convert a tool
reference to an object"*.

**F4. Speed and depth.** (measured) A 1M-iteration loop took 54 ms. Recursion stops at
depth 9,999 with `RangeError: Maximum call stack size exceeded`. A final expression
with no `return` becomes the result (`x + 2` → `42`). A 2 MB string came back whole.

**F5. Two probes took the server down.** (measured) `while (true) n++` and a memory
bomb (`parts.push('x'.repeat(1e6) + i)` in a loop) both ended as "Tool execution
interrupted", and then OpenCode's server restarted. I didn't run them again in-process.
See F12 for what I found when I ran them safely.

## Part 2: Reading OpenCode's source

**F6. It's `@opencode/codemode`: acorn → compiler → bytecode → VM.** (read)
`packages/codemode`, about 21,000 lines of TypeScript. Its only runtime dependencies
are `acorn` and `effect`. From its README: *"Rather than trying to sandbox arbitrary
JavaScript, CodeMode only runs the language features we implement."*
- Parser: acorn, `ecmaVersion: "latest"`, with `allowReturnOutsideFunction` and `allowAwaitOutsideFunction`.
- Compiler: `src/compiler/compile.ts`, 1,600 lines, emitting `Int32Array` bytecode.
- VM: `src/vm.ts`, 3,100 lines.
- Conformance: test262 runs verbatim, with 1,678 known failures listed in `test/test262/skipped.txt`.
- The final-expression result is done by the compiler: if the last statement is an
  expression, it emits `END_PROGRAM` with that value.

**F7. Cooperative time slicing.** (read) `vm.run()` returns a `Stop`: `host` (start these calls),
`slice` (yield), `done`, or `stuck`. Constants: `SLICE_MS = 1`, `INITIAL_FUEL = 10_000`,
`MAX_CALL_DEPTH = 10_000` (that's the 9,999 from F4). The driver calls
`Effect.yieldNow` on every slice, which is why a busy loop can't freeze the host.

**F8. "Stuck" detection.** (read) If the program awaits something and nothing is
running that could settle it, the run fails right away: *"Code Mode has no timers or
sleep, so don't wait or poll inside a program."* No waiting for a timeout.

**F9. The boundary is JSON.** (read) *"The host boundary is `JSON.stringify` plus a
short table."* Promises are awaited, Sets become arrays, `__proto__` keys are dropped,
depth is capped at 32. Values are copied, never shared.

**F10. `fetch` is a host "extension", gated like the webfetch tool.** (read)
`packages/core/src/codemode/fetch.ts`: rejects `file:` and URLs with credentials, checks
the same permission as `webfetch`, follows redirects manually (max 20) and re-checks
every hop, and has a 30 s timeout.

**F11. OpenCode's `execute` runs with no limits.** (read) `runtime()` in
`packages/core/src/codemode/tool.ts` calls `CodeMode.make({ tools, extensions, hooks })`
with no `limits`. The package's own defaults: *"Execution limits have no default
values."* So there's no timeout, no tool-call cap, no output cap. The per-operation
caps still apply: strings up to 2^24 characters, arrays up to 10M elements, 10,000
pending promises. **There is no total memory limit anywhere.**

**F12. The memory bomb, run safely.** (measured) I ran OpenCode's package in its own
Bun process, with a 20 s timeout and a watchdog that would kill it at 3 GB:

```
t=0.5s rss=1491MB ... t=10s rss=2337MB ... t=17s rss=2759MB
→ "Execution timed out after 20000ms."  rssMB: 2919
```

Even *with* a timeout it reached 2.9 GB. `execute` has no timeout, so in OpenCode it
keeps growing. That's very likely what restarted the server in F5. It's likely, not
proven: I didn't watch the server process's memory at the time.

## Part 3: Reading Rivet's secure-exec

**F13. A different design: real V8 isolates in a separate Rust process.** (read)
The `secure-exec` npm package is 371 lines of TypeScript wrapping agentOS. The actual
work happens in a Rust "sidecar" using `rusty_v8` 130 (not `deno_core`), talking to
your process over stdin/stdout plus fd 3, with length-prefixed BARE frames.
`node:fs`, `net` and `child_process` are polyfills backed by a virtual kernel, and
`sh` and coreutils are compiled to WebAssembly.

**F14. Real resource limits.** (read) `crates/v8-runtime/src/isolate.rs`:
`DEFAULT_HEAP_LIMIT_MB = 128`, plus a separate ArrayBuffer budget (ArrayBuffers live
outside the V8 heap). The comment there: *"an isolate is NEVER created with an
unbounded heap, so a guest heap bomb terminates its own isolate rather than
fatal-aborting the shared process."* There's also a CPU-time budget that reads the
execution thread's CPU clock every 50 ms and calls `terminate_execution()`. This is
exactly the gap F11/F12 found in OpenCode.

**F15. The claims don't all match the repo.** (read vs. claimed)
- The landing page says "17.9 ms cold start" and "3.4 MB per instance". Their own docs
  page reports 13.7 ms (existing VM) to 40.7 ms (one-shot), and says pooled warm isolates
  are "about 20 MiB" each.
- The page also says both "no sidecar" and "sidecar process separate from yours". The code has a sidecar.
- `crates/AGENTS.md` still warns *"CURRENTLY BROKEN: spawns real host node child
  processes"*. That looks stale: the guest path goes through `crates/v8-runtime`, and the
  remaining `node` spawns I found are in benchmark and test code.
- The security model page says agentOS *"is in beta and is still undergoing security review"*.

## Part 4: My first attempt (v1, `node:vm`)

**F16. I escaped my own sandbox on the first try.** (measured) v1 ran code in a
`vm` context inside a worker thread, with `eval` turned off. This still worked:

```js
globalThis.constructor.constructor("return process")()   // → the worker's process
```

A plain `vm.createContext({})` gives the guest a global object that is tied to a host
object, so its `constructor` chain leads back to the host. Node 22's
`vm.constants.DONT_CONTEXTIFY` fixed that case, and building every guest-visible object
inside the context fixed the others. But this is why Node's docs say `vm` *"is not a
security mechanism"*: you have to think of every path yourself.

## Part 5: Building minicode (v2, my own interpreter)

**F17. Generators make pausing easy.** (built) Every evaluation function is a
generator. An `await` is `yield { await: promise }`, and running out of fuel is
`yield TICK`. The driver resumes a task when its promise settles, and on TICK it checks
the clock, the heap and the abort signal, and every 1 ms it awaits `setImmediate`.
JS microtask ordering came out right the first time (tested against `then` chains).

**F18. Check the syntax first, before anything runs.** (built) If unsupported syntax were
only caught when execution reached it, a program could call tools and *then* fail on
line 20. minicode walks the whole tree first. A test checks that no tool ran.

**F19. A host stack overflow inside a `catch` handler.** (measured) Deep recursion
overflowed the *host* stack. My `catch` handler then ran `/call stack/i.test(message)`,
which needs stack space too, so it overflowed again. Fix: `message === "..."`, which
doesn't need a function call.

**F20. Each guest call costs about 1.8 KB of host stack.** (measured)
Recursion only reached **172** levels, against 9,999 in OpenCode's VM. V8's bytecode
printer gave the frame sizes: `expr` 368 bytes, `stmt` 192, `call` 120, plus the
generator-resume trampolines. Node's roughly 1 MB stack divided by 1.8 KB is about 550.
Cutting one generator frame per call and inlining the block loop got it to **556**.
Through `arr.map(callback)` it's 194. The real fix is OpenCode's design: a VM with its
own stack on the heap. This is the strongest reason to use bytecode.

**F21. Two optimizations, 5× faster.** (measured, with `--cpu-prof`)
- Before: 1M-iteration loop 720 ms, with the GC taking 20%. Each sub-expression allocated a generator.
- Idea: minicode never runs guest code implicitly (no getters, no `valueOf`, no
  `toString` overrides). So an expression with no call, `new` or `await` can't pause or
  loop. One pass marks those **pure**, and they get a synchronous evaluator. 720 → 189 ms.
- `for (let i ...)` copies its loop variable each iteration. That's only needed if a
  closure could capture it, so I only do it then. Plus synchronous "simple" statements:
  189 → 144 ms.
- No `arguments` object unless the body uses it, and identifier parameters skip the
  destructuring path: fib(20) 12.6 → 10.6 ms.
- The 1M loop ended at 142 ms (5×). OpenCode's VM does it in 40 ms on Bun, and plain V8 in 1 ms.

**F22. minicode escaped through its own method tables.** (measured, found while writing
an example) `({}).constructor` returned the **host** `Object` function. My method tables
(`methods.object`, `methods.string`, ...) were plain JS objects, so a lookup with a
guest-chosen key like `"constructor"` found `Object.prototype.constructor`. Guest code
couldn't call it (it isn't one of my callable classes), but a host value must never get
in at all. Fix: `Object.create(null)` tables. My first security test missed it because
it only checked the final JSON. The new test checks on the host side what `getProp`
returns for every `Object.prototype` and `Function.prototype` name on every kind of
receiver. I put the bug back to confirm the test fails without the fix.

**Lesson:** an interpreter doesn't remove the attack surface. It moves it into every
place where the interpreter touches host objects using a key the guest chose.

**F23. When does an un-awaited call actually start?** (measured, two bugs)
1. Host work started in a later microtask. If the program ended first, a tool could
   start *after* the run was over. Fix: call the tool synchronously when the guest calls
   it, like JavaScript does (and OpenCode: "it starts synchronously").
2. Then an instant tool that wasn't awaited was labelled "interrupted" even though it
   had run. Fix: record a synchronous result as completed straight away.

**F24. A memory limit that works.** (measured)
- What doesn't work: a cumulative allocation counter. `s += c` in a loop allocates
  O(n²) bytes in total while only keeping O(n), so it would fail correct programs.
- What I do: `v8.getHeapStatistics().used_heap_size` sampled on every TICK, and also
  after every ~16 MB of estimated allocation (strings, arrays, objects). Without that
  second check, 10,000 steps of 32 MB strings could overshoot badly between ticks.
- The F12 memory bomb now stops in **0.65 s at 338 MB** RSS. OpenCode's interpreter:
  2.9 GB after 20 s.
- Caveat: the heap is shared with the host, so this is a safety net, not isolation.
  Other host activity counts toward it, and garbage that hasn't been collected yet can
  trip it a little early.

**F25. Defaults matter more than features.** OpenCode has every limit available but
turns none of them on for `execute`. minicode turns them on by default: 30 s, 100 tool
calls, 64 KB output, 256 MB of heap growth.

## Part 6: Benchmarks

Median of 7 runs, in ms (`bench/`, raw JSON in `bench/results/`):

| Program | Native V8 | OpenCode VM (Bun) | minicode (Node) | minicode (Bun) | v1 node:vm+worker |
|---|---:|---:|---:|---:|---:|
| startup (1 + 1) | 0 | 0.8 | 0.4 | 1.1 | 18.7 |
| loop 1M | 0.98 | 39.8 | 142.4 | 540.9 | 20.9 |
| fib(20) recursion | 0.11 | 2.5 | 10.5 | 34.5 | 19.2 |
| array pipeline 100k | 5.33 | 43.2 | 56.2 | 306.9 | 24.2 |
| string building 20k | 0.21 | 3.4 | 15.1 | 210 | 19.3 |
| JSON 5k objects | 2.18 | 22.3 | 9.2 | 23.1 | 21.3 |
| object churn 50k | 3.53 | 50.5 | 18.8 | 129.7 | 24.6 |

What this shows:
- **Bytecode beats tree-walking on control flow.** OpenCode's VM is 3–4× faster on
  loops and calls, on an engine (Bun/JSC) where generators are slow.
- **The tree-walker wins when the work is in built-ins.** JSON and object-heavy code is
  faster in minicode, because `JSON.parse` and `Map` run as native host code.
- **Generators are much slower on JavaScriptCore** than on V8 (2–14× in the minicode
  rows). A design built on generators is tied to the engine it runs on.
- **Startup is where interpreters win.** About 0.5 ms, against about 19 ms to start a
  worker for `node:vm`, and 14–40 ms for secure-exec (their docs). For the short scripts
  models usually write, startup and tool latency matter more than loop speed.

## Part 7: What I'd tell someone choosing

- **Glue code a model writes to call your tools:** an interpreter (OpenCode's, or a
  small one like this). Starts in under 1 ms, runs anywhere JS runs, nothing to reach.
  Turn the limits on.
- **The model needs npm, a filesystem, or real speed:** isolates with real limits
  (secure-exec, isolated-vm), or a container or microVM if you need full OS isolation.
- **Never:** `node:vm` by itself, for code you didn't write.
