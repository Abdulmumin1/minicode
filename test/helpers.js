import { createRuntime } from "../src/index.js";

export const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

export const testTools = {
  math: {
    add: {
      description: "Add two numbers.",
      input: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      output: { type: "number" },
      execute: ({ a, b }) => a + b,
    },
  },
  slow: {
    echo: {
      description: "Echo a value after a delay.",
      input: { type: "object", properties: { value: {}, ms: { type: "number" } } },
      execute: async ({ value, ms = 20 }, { signal }) => {
        await wait(ms, signal);
        return value;
      },
    },
    fail: {
      description: "Always fails.",
      execute: async () => {
        throw new Error("the tool broke");
      },
    },
  },
  host: {
    leaky: {
      description: "Returns host objects that are not plain data.",
      execute: () => ({ fn: () => 1, date: new Date(0), nested: { ok: true }, proto: Object.create({ inherited: 1 }) }),
    },
    inspect: {
      description: "Reports what the host received.",
      execute: (input) => ({
        keys: Object.keys(input),
        protoIsObject: Object.getPrototypeOf(input) === Object.prototype,
        polluted: {}.polluted === true,
      }),
    },
  },
};

export const runtime = createRuntime({ tools: testTools });

export async function run(code, options) {
  const rt = options ? createRuntime({ tools: testTools, ...options }) : runtime;
  return rt.execute(code);
}

export async function value(code, options) {
  const r = await run(code, options);
  if (!r.ok) throw new Error(`Program failed: ${r.error.kind}: ${r.error.message}`);
  return r.value;
}
