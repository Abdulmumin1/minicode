import { createRuntime } from "../src/index.js";
const code = "const parts = []; for (let i = 0; i < 1e9; i++) parts.push('x'.repeat(1e6) + i); parts.length";
const t0 = performance.now();
const r = await createRuntime({ limits: { timeoutMs: 20_000 } }).execute(code);
console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), ok: r.ok, error: r.error, rssMB: Math.round(process.memoryUsage().rss / 1e6) }));
