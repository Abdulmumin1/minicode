// Usage: node bench/minicode.js   (or: bun bench/minicode.js)
import { createRuntime } from "../src/index.js";
import { programs } from "./programs.js";

const runtime = createRuntime({ limits: { timeoutMs: 120_000 } });
const runs = Number(process.env.RUNS ?? 5);
const results = {};
for (const [name, code] of Object.entries(programs)) {
  const times = [];
  let value;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await runtime.execute(code);
    times.push(performance.now() - t0);
    value = r.ok ? r.value : r.error.message;
  }
  times.sort((a, b) => a - b);
  results[name] = { ms: Math.round(times[Math.floor(times.length / 2)] * 10) / 10, value };
}
console.log(JSON.stringify(results));
