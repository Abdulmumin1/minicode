# Introducing minicode — A Letter from the Workbench

*I am releasing a small, open runtime for running the JavaScript a model writes, built to show how a code mode sandbox works from the inside.*

*minicode* means a little code, run carefully. When a model uses code mode, it writes one short program that calls your tools, and something has to run that program on a machine that holds your credentials. Most people meet that something as a package to install. Few can say what it does when the program loops forever, builds a few gigabytes of strings, or reaches for `process`. Given that agents now run code nobody has read, how the sandbox works shouldn't be a mystery, and the parts should be small enough to read in an afternoon.

My goal with minicode is a runtime you can read end to end, and a set of experiments that show where each kind of sandbox holds and where it gives. To be worth learning from, it has to be **small** and **confined**.

**Small.** A sandbox is a parser, an interpreter, a scheduler and a boundary. Real ones hide those parts behind thousands of lines and native code. minicode is about 3,000 lines of JavaScript with one dependency, acorn, so every decision is somewhere you can read it.

**Confined.** The program can only do what the interpreter implements. There is no `process`, `require`, `eval`, `globalThis` or timers. Guest objects have no prototypes, values cross the boundary only as JSON copies, and the only way out is a tool call. Limits are on by default: 30 s, 100 tool calls, 64 KB of output, and 256 MB of heap growth.

minicode exists to make that understandable. I built it alongside a close reading of OpenCode's interpreter and Rivet's secure-exec, and I'm releasing it open-source so others can run the experiments, break it, and build on it. It isn't meant for production. It has had no security review beyond mine, and the notes include two escapes I found in it myself.

Today I'm releasing the first version: the runtime, a playground, eight example programs, 106 tests and a benchmark suite. It needs Node 22. Add it to a project with `npm install minicode-runtime`, or clone the repo and run `npm start` for the playground or `npm test` for the tests. You can read the story in [the post](https://yaqeen.me/blog/i-built-a-code-mode-sandbox), or the detailed evidence in [the findings](FINDINGS.md).

![The minicode playground](https://yaqeen.me/blog/i-built-a-code-mode-sandbox/playground-parallel.png)

### My approach: an interpreter, not a sandbox

You can't easily make real JavaScript safe. Every object has a prototype, every function has a `constructor`, and any one of them that comes from the host is a ladder back out. That's why `node:vm` fell on the first try.

So minicode doesn't run your JavaScript. It reads it with acorn, refuses anything outside a safe subset before a single tool runs, and walks the syntax tree with generators, so any step can pause for an `await` or a time slice. A driver gives the host a turn every millisecond, checks the clock and the heap, and passes tool calls across as copies. It's the same approach OpenCode takes, done more simply, so the trade-offs are easy to see.

![How minicode runs a program](https://yaqeen.me/blog/i-built-a-code-mode-sandbox/04-how-minicode-runs.png)

I'm sharing three things you can run to see it:

*   a [playground](playground/) (`npm start`) with a tool-call timeline, and a server ping that keeps answering while a runaway loop runs;
*   [eight example programs](examples/): parallel tools, errors, search, escape attempts, a runaway loop, a memory bomb and a forgotten `await`;
*   a [benchmark suite](bench/) running the same programs on minicode, OpenCode's VM, `node:vm` and plain V8.

Each of these shows one part of the runtime doing its job, or failing to, where you can see it.

### Moving forward

I think anyone who lets a model run code should understand, in detail, what's running it. A small runtime is a good place to start that conversation. I'll keep the notes honest, fix what people find, and say so when I'm wrong.

At the same time, there's a clear next step. A tree-walker built from generators uses host stack for every guest call, so recursion stops at about 500 levels. A bytecode VM with its own stack, like OpenCode's, fixes that, and also makes it possible to pause a run and resume it later. That's what I'd build next.

I'm excited to keep learning this in public. Whether you want to [read the post](https://yaqeen.me/blog/i-built-a-code-mode-sandbox), [run the tests](test/), [try to break it](examples/05-escape-attempts.js), or tell me what I got wrong, I can't wait to hear from you.

Yaqeen

---

## Using it

```bash
npm install minicode-runtime
```

```js
import { createRuntime } from "minicode-runtime";

const runtime = createRuntime({
  tools: {
    weather: {
      get: {
        description: "Get the current weather for a city.",
        input: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        execute: async ({ city }, { signal }) => fetchWeather(city, { signal }),
      },
    },
  },
  limits: { timeoutMs: 30_000, maxToolCalls: 100, maxOutputBytes: 64_000, maxHeapGrowthMB: 256 },
  fetch: { allow: ["api.github.com"] }, // optional: a `fetch` global for these hosts only
});

// Put this in the model's prompt: TypeScript-style signatures for every tool.
const catalog = runtime.describe();

// Run what the model wrote.
const result = await runtime.execute(`
  const cities = ["Lagos", "Abuja", "Nairobi"];
  const weather = await Promise.all(cities.map((city) => tools.weather.get({ city })));
  return weather.toSorted((a, b) => b.tempC - a.tempC)[0];
`);

if (result.ok) console.log(result.value);
else console.error(result.error.kind, result.error.message);
```

`execute` never throws for a program's mistakes. It returns `{ ok, value | error, logs, toolCalls, warnings?, stats }`, where `error.kind` is one of `ParseError`, `UnsupportedSyntax`, `ExecutionFailure`, `TimeoutExceeded`, `ToolCallLimitExceeded`, `MemoryLimit`, `ResourceLimit`, `Stuck`, `Interrupted` or `InvalidResult`. Pass `{ signal }` as the second argument to stop a run from outside.

**Inside a program:** `tools.*`, `search()`, `console`, `await`, functions, closures, destructuring, spread, optional chaining, template literals, loops, `switch`, `try`/`catch`/`finally`, Promise (`all`, `allSettled`, `race`, `any`), Array, String, Object, Math, JSON, Map, Set, Date and RegExp. With no `return`, the last expression is the result.

**Not inside:** classes, generators, getters and setters, BigInt, Symbols, `import`, `eval`, timers, and on purpose `process`, `require` and `globalThis`. Unsupported syntax fails before anything runs.

**Caveats:** it has had no security review beyond mine. Recursion stops at about 500 levels. The memory limit samples the host's heap, so it's a safety net rather than isolation. It's 4 to 150 times slower than plain V8, which is fine for glue code and not for heavy computation.

| Path | What it is |
|---|---|
| `src/` | The runtime: values, interpreter, built-ins, driver, catalog |
| `playground/` | The web playground and its demo tools |
| `examples/` | Programs to try, including escape attempts and a memory bomb |
| `test/` | 106 tests: language, async, security, limits |
| `bench/` | The same programs on minicode, OpenCode's VM, `node:vm` and plain V8 |
| `post/diagrams/` | Mermaid sources for the post's diagrams |
| `v1-node-vm/` | My first attempt, kept as a warning |
