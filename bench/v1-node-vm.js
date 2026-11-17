// The v1 approach: node:vm in a worker thread (one worker per run).
import { runCode } from "../v1-node-vm/src/sandbox.js";
import { programs } from "./programs.js";

const runs = Number(process.env.RUNS ?? 5);
const results = {};
for (const [name, code] of Object.entries(programs)) {
  const body = code.trim().split(";");
  const last = body.pop();
  const src = `${body.join(";")}; return (${last});`;
  const times = [];
  let value;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await runCode(src, { tools: {}, timeoutMs: 120_000, syncTimeoutMs: 120_000 });
    times.push(performance.now() - t0);
    value = r.ok ? r.result : r.error;
  }
  times.sort((a, b) => a - b);
  results[name] = { ms: Math.round(times[Math.floor(times.length / 2)] * 10) / 10, value };
}
console.log(JSON.stringify(results));
