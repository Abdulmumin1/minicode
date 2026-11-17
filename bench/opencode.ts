// OpenCode's @opencode/codemode on the same programs. Run with bun.
// Copy this file into a checkout of github.com/anomalyco/opencode at packages/codemode/,
// then run it with: RUNS=7 bun bench-opencode.ts > results/opencode-bun.json
import { CodeMode } from "./src/index.ts"
import { Effect } from "effect"
import { programs } from "<path to minicode>/bench/programs.js"

const runs = Number(process.env.RUNS ?? 5)
const results: Record<string, { ms: number; value: unknown }> = {}
for (const [name, code] of Object.entries(programs)) {
  const times: number[] = []
  let value: unknown
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    const r = await Effect.runPromise(CodeMode.execute({ code, limits: { timeoutMs: 120_000 } }))
    times.push(performance.now() - t0)
    value = r.ok ? r.value : r.error.message
  }
  times.sort((a, b) => a - b)
  results[name] = { ms: Math.round(times[Math.floor(times.length / 2)] * 10) / 10, value }
}
console.log(JSON.stringify(results))
