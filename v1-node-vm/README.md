# Code Mode Sandbox

A tiny runtime for learning how "Code Mode" works. Instead of an AI calling
tools one at a time, it writes a short JavaScript program that calls
`tools.*`, and that program runs in a locked-down sandbox.

No dependencies. Needs Node 22.8 or newer.

```bash
npm start                              # web playground at http://localhost:3000
node src/cli.js examples/03-parallel.js
echo 'return await tools.math.add({ a: 1, b: 2 })' | node src/cli.js
```

## How it works

```
 your code ──► worker thread ──► vm context (the sandbox)
                     │                │  has only: tools, search, console, fetch
                     │                │
                     │◄── "call tools.weather.get {city:'Lagos'}" (a message)
  host (sandbox.js)  │
  runs the real tool ├──► result sent back as JSON ──► the await in your code finishes
```

| File | What it does |
| --- | --- |
| `src/tools.js` | The tools: `math`, `weather`, `notes`. Add your own here. |
| `src/sandbox.js` | Host side. Starts a worker, runs tool calls, enforces time and memory limits. |
| `src/worker.js` | Sandbox side. Builds the empty context and runs your code in it. |
| `src/cli.js` | Runs a file from the terminal. |
| `src/server.js` + `public/index.html` | The web playground. |
| `examples/` | Things to try, from hello world to escape attempts. |

## The safety layers

1. **Empty global scope.** No `require`, `import`, `process`, or `setTimeout`.
   The code can only use what the sandbox gives it.
2. **No `eval` or `new Function`.** Turned off with `codeGeneration: { strings: false }`.
3. **No host objects inside.** Everything the code can reach is created
   inside the sandbox, and data crosses the boundary only as JSON strings.
   Otherwise `someHostObject.constructor.constructor("return process")()` gets out.
   See `examples/06-escape-attempts.js`.
4. **Time limits.** `vm`'s `timeout` stops `while(true){}`. The host kills the
   worker if the whole run takes over 5s.
5. **Memory limits.** The worker gets 64 MB of heap.
6. **Tool call cap and fetch allowlist.** 50 calls max, and `fetch` only reaches
   hosts in `allowedFetchHosts`.

⚠️ This is for learning. `node:vm` is **not** a real security boundary. The
Node docs say not to use it for untrusted code. Real systems use stronger
isolation: `isolated-vm`, QuickJS compiled to WebAssembly, Deno, Cloudflare
Workers, or a separate container/VM.

## Exercises

- Add a tool, e.g. `tools.text.reverse({ text })`, then call it.
- Make tool calls check their arguments against a schema before running.
- Support "the last expression is the result" when there's no `return`.
- Add `tools.notes.delete` and make it require a `confirm: true` argument.
- Let an LLM write the code: send it the catalog from `catalog()` and run its reply with `runCode`.
- Swap `node:vm` for `isolated-vm` or QuickJS and see what changes.
