// Baseline: the same programs as plain JavaScript, no sandbox at all.
import { programs } from "./programs.js";

const runs = Number(process.env.RUNS ?? 5);
const results = {};
for (const [name, code] of Object.entries(programs)) {
  const body = code.trim().split(";");
  const last = body.pop();
  const fn = new Function(`${body.join(";")}; return (${last});`);
  const times = [];
  let value;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    value = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  results[name] = { ms: Math.round(times[Math.floor(times.length / 2)] * 100) / 100, value };
}
console.log(JSON.stringify(results));
