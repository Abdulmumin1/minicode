// The host side. Starts a worker for each run, answers its tool calls,
// and kills it if it takes too long or uses too much memory.

import { Worker } from "node:worker_threads";
import { catalog, findTool, searchTools, tools as defaultTools } from "./tools.js";

export function runCode(code, options = {}) {
  const {
    tools = defaultTools,
    timeoutMs = 5000,
    syncTimeoutMs = 1000,
    allowedFetchHosts = [],
    maxToolCalls = 50,
  } = options;

  return new Promise((resolve) => {
    const started = Date.now();
    const logs = [];
    const calls = [];
    let done = false;

    const worker = new Worker(new URL("./worker.js", import.meta.url), {
      workerData: {
        code,
        paths: catalog(tools).map((t) => t.path),
        allowFetch: allowedFetchHosts.length > 0,
        syncTimeoutMs,
      },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });

    const timer = setTimeout(
      () => finish({ ok: false, error: `Timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );

    function finish(outcome) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      resolve({ ...outcome, logs, calls, ms: Date.now() - started });
    }

    worker.on("message", async (msg) => {
      if (msg.type === "log") {
        logs.push({ level: msg.level, text: msg.text });
      } else if (msg.type === "done") {
        finish(
          msg.ok
            ? { ok: true, result: msg.json === undefined ? undefined : JSON.parse(msg.json) }
            : { ok: false, error: msg.error },
        );
      } else if (msg.type === "call") {
        const callStart = Date.now();
        const entry = { path: msg.path, args: JSON.parse(msg.argsJson) };
        calls.push(entry);
        try {
          if (calls.length > maxToolCalls) throw new Error(`Too many tool calls (max ${maxToolCalls})`);
          const value = await handleCall(msg.path, entry.args, tools, allowedFetchHosts);
          entry.ms = Date.now() - callStart;
          entry.ok = true;
          if (!done) {
            worker.postMessage({
              type: "result", id: msg.id, ok: true,
              json: value === undefined ? undefined : JSON.stringify(value),
            });
          }
        } catch (e) {
          entry.ms = Date.now() - callStart;
          entry.ok = false;
          entry.error = e.message;
          if (!done) worker.postMessage({ type: "result", id: msg.id, ok: false, error: e.message });
        }
      }
    });

    worker.on("error", (e) => finish({ ok: false, error: e.message }));
    worker.on("exit", (code) => finish({ ok: false, error: `Sandbox exited (code ${code})` }));
  });
}

async function handleCall(path, args, tools, allowedFetchHosts) {
  if (path === "__search") return searchTools(tools, args);

  if (path === "__fetch") {
    const url = new URL(args.url);
    if (!allowedFetchHosts.includes(url.hostname)) {
      throw new Error(`fetch to ${url.hostname} is not allowed`);
    }
    const res = await fetch(url, { method: args.init.method, headers: args.init.headers, body: args.init.body });
    const body = (await res.text()).slice(0, 100_000);
    return { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers), body };
  }

  const tool = findTool(tools, path);
  if (!tool) throw new Error(`Unknown tool: ${path}`);
  return await tool.run(args ?? {});
}
