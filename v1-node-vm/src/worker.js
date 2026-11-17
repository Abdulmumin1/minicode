// Runs inside a worker thread. Builds a fresh V8 context (via node:vm) that
// contains ONLY what we put there: `tools`, `search`, `console`, `fetch`.
// No require, no import, no process, no setTimeout, no eval.

import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

const { code, paths, allowFetch, syncTimeoutMs } = workerData;

// --- Bridge: the only way out of the sandbox is a message to the host. ----
let nextId = 0;
const pending = new Map();

parentPort.on("message", (msg) => {
  if (msg.type !== "result") return;
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  msg.ok ? p.resolve(msg.json) : p.reject(new Error(msg.error));
});

const bridge = {
  call(path, argsJson) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      parentPort.postMessage({ type: "call", id, path, argsJson });
    });
  },
  log(level, text) {
    parentPort.postMessage({ type: "log", level, text: String(text) });
  },
};

// --- The sandbox context. ------------------------------------------------
// codeGeneration.strings=false disables eval() and new Function() inside it.
// DONT_CONTEXTIFY gives the sandbox a plain global object of its own. Without
// it, the global is linked to a host object, and
// `globalThis.constructor.constructor("return process")()` escapes.
const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
  name: "codemode-sandbox",
  codeGeneration: { strings: false, wasm: false },
});

// This setup function is compiled INSIDE the sandbox, so every object the
// user can touch (tools, results, errors, promises) belongs to the sandbox's
// own realm. If we handed host objects in directly, user code could do
// `tools.constructor.constructor("return process")()` and escape.
// Data crosses the boundary only as JSON strings.
const SETUP = `
(function setup(bridge, pathsJson, allowFetch) {
  const call = async (path, args) => {
    let raw;
    try {
      raw = await bridge.call(path, JSON.stringify(args === undefined ? {} : args));
    } catch (e) {
      throw new Error(String(e && e.message));
    }
    return raw === undefined ? undefined : JSON.parse(raw);
  };

  const tools = {};
  for (const path of JSON.parse(pathsJson)) {
    const [, ns, name] = path.split(".");
    tools[ns] = tools[ns] || {};
    tools[ns][name] = (args) => call(path, args);
  }
  for (const ns of Object.keys(tools)) Object.freeze(tools[ns]);
  Object.freeze(tools);

  const show = (v) => typeof v === "string" ? v : (() => {
    try { return JSON.stringify(v); } catch { return String(v); }
  })();
  const log = (level) => (...args) => bridge.log(level, args.map(show).join(" "));

  globalThis.tools = tools;
  globalThis.search = (opts) => call("__search", opts || {});
  globalThis.console = Object.freeze({ log: log("log"), warn: log("warn"), error: log("error") });
  globalThis.fetch = async (url, init) => {
    if (!allowFetch) throw new Error("fetch is disabled in this sandbox");
    const r = await call("__fetch", { url: String(url), init: init || {} });
    return { ok: r.ok, status: r.status, headers: r.headers,
             text: async () => r.body, json: async () => JSON.parse(r.body) };
  };
})
`;

function send(msg) {
  parentPort.postMessage({ type: "done", ...msg });
}

try {
  const setup = new vm.Script(SETUP).runInContext(context);
  setup(bridge, JSON.stringify(paths), Boolean(allowFetch));

  // Wrap the user's code in an async function so top-level `await` and
  // `return` work. lineOffset keeps error line numbers matching their code.
  const script = new vm.Script(`(async () => {\n${code}\n})()`, {
    filename: "sandbox.js",
    lineOffset: -1,
  });

  // `timeout` only stops synchronous runaway code (e.g. while(true){}).
  // Async runaway code is stopped by the host killing this worker.
  const value = await script.runInContext(context, { timeout: syncTimeoutMs });

  let json;
  try {
    json = value === undefined ? undefined : JSON.stringify(value);
  } catch {
    json = JSON.stringify(String(value));
  }
  send({ ok: true, json });
} catch (e) {
  // Keep the message and the user's own lines; hide host file paths.
  const [first, ...rest] = String((e && e.stack) || e).split("\n");
  const userLines = rest.filter((l) => l.includes("sandbox.js"));
  send({ ok: false, error: [first, ...userLines].join("\n") });
}
