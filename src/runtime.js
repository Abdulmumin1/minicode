// The driver: the only place guest code meets the host.
//
// It runs the interpreter's job queue, gives the host event loop a turn every
// SLICE_MS, starts tool calls, feeds their results back in, and enforces the
// limits: time, tool calls, output size and memory.

import { getHeapStatistics } from "node:v8";
import { FUEL, Interpreter, SyntaxProblem, parseProgram } from "./interpreter.js";
import { display, guestToJsonText, jsonToGuest, makeGlobals } from "./builtins.js";
import { describeCatalog, flattenTools, searchTools, toolExpression, validate } from "./catalog.js";
import { GError, GObj, GuestThrow, Halt, NFn } from "./values.js";

const SLICE_MS = 1;
const MAX_BOUNDARY_DEPTH = 32;

export const DEFAULT_LIMITS = {
  timeoutMs: 30_000,
  maxToolCalls: 100,
  maxOutputBytes: 64_000,
  maxHeapGrowthMB: 256,
};

const yieldToHost = () => new Promise((resolve) => setImmediate(resolve));
const heapUsed = () => getHeapStatistics().used_heap_size;

export function createRuntime({ tools = {}, limits = {}, fetch: fetchOptions } = {}) {
  const registry = flattenTools(tools);
  const config = { ...DEFAULT_LIMITS, ...limits };
  return {
    catalog: () => [...registry.values()].map((t) => ({ path: toolExpression(t.path), description: t.description })),
    describe: () => describeCatalog(registry),
    execute: (code, options = {}) => execute(code, { registry, config, fetchOptions, ...options }),
  };
}

// Host values cross into the guest as JSON: no functions, no prototypes, no sharing.
function fromHost(value) {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text);
  if (depth(parsed) > MAX_BOUNDARY_DEPTH) throw new Error(`Value is nested deeper than ${MAX_BOUNDARY_DEPTH} levels`);
  return jsonToGuest(parsed);
}

// Guest values cross out as JSON too. `__proto__` keys are dropped so a tool
// that merges its input into an object can't have its prototype replaced.
function toHost(interp, value) {
  const text = guestToJsonText(interp, value);
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text, (key, v) => (key === "__proto__" ? undefined : v));
  if (depth(parsed) > MAX_BOUNDARY_DEPTH) interp.typeError(`Value is nested deeper than ${MAX_BOUNDARY_DEPTH} levels`);
  return parsed;
}

function depth(v, d = 0) {
  if (v === null || typeof v !== "object" || d > MAX_BOUNDARY_DEPTH) return d;
  let max = d + 1;
  for (const x of Object.values(v)) max = Math.max(max, depth(x, d + 1));
  return max;
}

function locate(e) {
  return e?.at ? ` (line ${e.at.line}, column ${e.at.column + 1})` : "";
}

async function execute(code, { registry, config, fetchOptions, signal }) {
  const started = performance.now();
  const logs = [];
  const toolCalls = [];
  const warnings = [];
  let logBytes = 0;
  let truncated = false;
  const stats = { steps: 0, slices: 0, jobs: 0 };

  const finish = (outcome) => ({
    ...outcome,
    ...(warnings.length ? { warnings } : {}),
    logs,
    ...(truncated ? { truncated } : {}),
    toolCalls,
    stats: { ...stats, ms: Math.round((performance.now() - started) * 10) / 10 },
  });
  const failure = (kind, message, extra = {}) => finish({ ok: false, error: { kind, message, ...extra } });

  let ast;
  try {
    ast = parseProgram(code);
  } catch (e) {
    if (e instanceof SyntaxProblem) return failure(e.kind, e.message, e.line ? { line: e.line, column: e.column + 1 } : {});
    throw e;
  }

  // ---- host-side state for this run ----
  const controller = new AbortController(); // interrupts tool calls still running at the end
  const inbox = []; // finished host calls, waiting to settle their guest promises
  let wake = null;
  let running = 0;
  let callCount = 0;
  let finished = false;
  const heapBase = heapUsed();
  let allocatedSinceCheck = 0;

  const checkHeap = () => {
    allocatedSinceCheck = 0;
    const grownMB = (heapUsed() - heapBase) / 1e6;
    if (grownMB > config.maxHeapGrowthMB) {
      throw new Halt("MemoryLimit", `The program used more than ${config.maxHeapGrowthMB} MB of memory.`);
    }
  };

  // Start host work. Its result is delivered later through the inbox, in completion order.
  const startHostCall = (interp, { label, input, run, convert = fromHost }) => {
    const promise = interp.newPromise();
    const t0 = performance.now();
    const record = { tool: label, input, status: "running", startMs: Math.round(t0 - started) };
    toolCalls.push(record);
    // Start the host work now, as JavaScript would. Deferring it to a later
    // microtask would let it begin after the program had already ended.
    let result;
    let outcome;
    try {
      result = run(controller.signal);
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (outcome || typeof result?.then !== "function") {
      // Finished synchronously: it has happened, whatever the program does next.
      outcome ??= { ok: true, value: result };
      record.ms = Math.round(performance.now() - t0);
      record.status = outcome.ok ? "completed" : "error";
      if (!outcome.ok) record.error = String(outcome.error?.message ?? outcome.error);
      inbox.push({ promise, outcome, convert });
      return promise;
    }
    running++;
    result
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      )
      .then((outcome) => {
        running--;
        record.ms = Math.round(performance.now() - t0);
        if (finished) {
          if (record.status === "running") record.status = "interrupted";
          return;
        }
        record.status = outcome.ok ? "completed" : "error";
        if (!outcome.ok) record.error = String(outcome.error?.message ?? outcome.error);
        inbox.push({ promise, outcome, convert });
        wake?.();
      });
    return promise;
  };

  const drainInbox = (interp) => {
    while (inbox.length) {
      const { promise, outcome, convert } = inbox.shift();
      if (!outcome.ok) {
        interp.reject(promise, interp.makeError("Error", String(outcome.error?.message ?? outcome.error)));
        continue;
      }
      try {
        interp.resolve(promise, convert(outcome.value, interp));
      } catch (e) {
        interp.reject(promise, interp.makeError("TypeError", `Invalid tool output: ${e.message}`));
      }
    }
  };

  const admit = (label) => {
    if (++callCount > config.maxToolCalls) {
      throw new Halt("ToolCallLimitExceeded", `The program made more than ${config.maxToolCalls} tool calls (${label}).`);
    }
  };

  const host = {
    alloc(bytes) {
      allocatedSinceCheck += bytes;
      if (allocatedSinceCheck > 16e6) checkHeap();
    },
    log(level, text) {
      const line = level === "log" || level === "info" ? text : `[${level}] ${text}`;
      logBytes += line.length;
      if (logBytes > config.maxOutputBytes) {
        truncated = true;
        return;
      }
      logs.push(line);
    },
    search(opts) {
      admit("search");
      const query = typeof opts === "string" ? { query: opts } : opts === undefined ? {} : toHost(interp, opts);
      toolCalls.push({ tool: "search", input: query, status: "completed", ms: 0 });
      return jsonToGuest(searchTools(registry, query));
    },
    callTool(path, args) {
      const name = path.join(".");
      const tool = registry.get(name);
      if (!tool) {
        interp.typeError(`${toolExpression(path)} is not a function. There is no such tool; use search() to find tools.`);
      }
      admit(toolExpression(path));
      const input = args[0] === undefined ? {} : toHost(interp, args[0]);
      const problems = tool.input ? validate(tool.input, input) : [];
      if (problems.length) {
        const p = interp.newPromise();
        toolCalls.push({ tool: toolExpression(path), input, status: "error", error: problems.join("; ") });
        interp.reject(p, interp.makeError("TypeError", `Invalid input for ${toolExpression(path)}: ${problems.join("; ")}`));
        return p;
      }
      return startHostCall(interp, {
        label: toolExpression(path),
        input,
        run: (signal) => tool.execute(input, { signal }),
      });
    },
  };

  const extensions = {};
  if (fetchOptions) extensions.fetch = makeFetch(fetchOptions, startHostCall, admit);

  const interp = new Interpreter({ host, globals: (i) => makeGlobals(i, { extensions }) });
  const main = interp.newPromise();
  main.handled = true;
  interp.queueJob(interp.stepTask({ gen: interp.programBody(ast), promise: main }));

  const deadline = started + config.timeoutMs;
  let sliceStart = performance.now();

  // End the run: interrupt host work still running, and say so in the record.
  const stop = () => {
    finished = true;
    controller.abort();
    stats.steps = interp.steps;
    for (const call of toolCalls) if (call.status === "running") call.status = "interrupted";
  };

  const checkTimeAndYield = async () => {
    const now = performance.now();
    if (now > deadline) throw new Halt("TimeoutExceeded", `The program ran for more than ${config.timeoutMs} ms.`);
    if (signal?.aborted) throw new Halt("Interrupted", "The program was interrupted.");
    if (now - sliceStart >= SLICE_MS) {
      await yieldToHost();
      stats.slices++;
      sliceStart = performance.now();
    }
  };

  try {
    let head = 0;
    while (main.state === "pending") {
      if (head < interp.jobs.length) {
        const job = interp.jobs[head++];
        if (head > 1024) {
          interp.jobs.splice(0, head);
          head = 0;
        }
        stats.jobs++;
        // A job only ever yields TICK: its fuel ran out.
        while (!job.next().done) {
          interp.fuel = FUEL;
          checkHeap();
          await checkTimeAndYield();
        }
        drainInbox(interp);
        if (performance.now() - sliceStart >= SLICE_MS) await checkTimeAndYield();
        continue;
      }
      if (inbox.length) {
        drainInbox(interp);
        continue;
      }
      if (running > 0) {
        // Nothing to run until a host call finishes.
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, deadline - performance.now()) + 1);
          const onAbort = () => resolve();
          signal?.addEventListener("abort", onAbort, { once: true });
          wake = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve();
          };
        });
        wake = null;
        await checkTimeAndYield();
        continue;
      }
      throw new Halt(
        "Stuck",
        "The program is waiting on a promise that can never settle: nothing else is running. There are no timers here, so don't wait or poll inside a program.",
      );
    }
  } catch (e) {
    stop();
    if (e instanceof Halt) return failure(e.kind, e.message);
    if (e instanceof RangeError && /call stack/i.test(e.message)) return failure("ExecutionFailure", "RangeError: Maximum call stack size exceeded");
    return failure("InternalError", `The runtime failed: ${e.message}`);
  }

  // The program is done. Anything still running is interrupted, not awaited.
  stop();
  if (running > 0) {
    warnings.push(`${running} call(s) were still running when the program ended and were interrupted. Await every call whose result matters.`);
  }
  for (const p of interp.unhandled) {
    if (p !== main) warnings.push(`Unhandled promise rejection: ${display(interp, p.value)}`);
  }

  if (main.state === "rejected") {
    const err = main.value;
    const message = err instanceof GError ? `${display(interp, err)}${locate(err)}` : `Uncaught ${display(interp, err)}`;
    return failure("ExecutionFailure", message);
  }

  let value;
  try {
    value = toHost(interp, main.value) ?? null;
  } catch (e) {
    const message = e instanceof GuestThrow ? display(interp, e.value) : e.message;
    return failure("InvalidResult", `The result could not be returned: ${message}`);
  }
  const text = JSON.stringify(value);
  if (text.length > config.maxOutputBytes) {
    truncated = true;
    value = `${text.slice(0, config.maxOutputBytes)}... [truncated: the result was ${text.length} bytes; return less data]`;
  }
  return finish({ ok: true, value });
}

// `fetch` is a host extension, like OpenCode's: the guest gets a function, the
// host decides what it may reach. Every hop of a redirect is checked.
function makeFetch({ allow = [], timeoutMs = 15_000, maxBytes = 1_000_000 }, startHostCall, admit) {
  const allowed = (url) => {
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return allow.includes("*") || allow.includes(url.hostname);
  };
  return new NFn("fetch", function* (interp, self, [input, init]) {
    admit("fetch");
    const opts = init === undefined ? {} : toHost(interp, init);
    let url;
    try {
      url = new URL(interp.toStr(input));
    } catch {
      interp.typeError(`Invalid URL: ${interp.toStr(input)}`);
    }
    return startHostCall(interp, {
      label: "fetch",
      input: { url: url.href, method: opts.method ?? "GET" },
      run: async (signal) => {
        let target = url;
        for (let hop = 0; hop <= 5; hop++) {
          if (!allowed(target)) throw new Error(`fetch to ${target.hostname} is not allowed`);
          const res = await globalThis.fetch(target, {
            method: opts.method,
            headers: opts.headers,
            body: opts.body,
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
          });
          const location = res.headers.get("location");
          if (res.status >= 300 && res.status < 400 && location) {
            target = new URL(location, target);
            continue;
          }
          const body = (await res.text()).slice(0, maxBytes);
          return { status: res.status, ok: res.ok, url: target.href, headers: Object.fromEntries(res.headers), body };
        }
        throw new Error("Too many redirects");
      },
      convert: (r, ip) => {
        const response = new GObj();
        response.props.set("status", r.status);
        response.props.set("ok", r.ok);
        response.props.set("url", r.url);
        response.props.set("headers", jsonToGuest(r.headers));
        response.props.set("text", new NFn("text", function* (i) {
          return i.toPromise(r.body);
        }));
        response.props.set("json", new NFn("json", function* (i) {
          try {
            return i.toPromise(jsonToGuest(JSON.parse(r.body)));
          } catch (e) {
            i.throwError("SyntaxError", e.message);
          }
        }));
        return response;
      },
    });
  });
}
