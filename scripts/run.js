// Run a program from the terminal with the playground's demo tools.
//   node scripts/run.js examples/02-parallel-tools.js
//   node scripts/run.js -e "await tools.math.add({ a: 1, b: 2 })"
//   node scripts/run.js --describe          (what the model sees)
import { readFileSync } from "node:fs";
import { createRuntime } from "../src/index.js";
import { demoTools } from "../playground/tools.js";

const args = process.argv.slice(2);
const runtime = createRuntime({ tools: demoTools, limits: { timeoutMs: Number(process.env.TIMEOUT ?? 3000) } });

if (args[0] === "--describe") {
  console.log(runtime.describe());
  process.exit(0);
}

const code = args[0] === "-e" ? args[1] : readFileSync(args[0] ?? 0, "utf8");
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const r = await runtime.execute(code);

for (const line of r.logs) console.log(dim("log  ") + line);
if (r.toolCalls.length) {
  const end = Math.max(r.stats.ms, ...r.toolCalls.map((c) => (c.startMs ?? 0) + (c.ms ?? 0)), 1);
  const width = 40;
  console.log(dim("\ntool calls"));
  for (const c of r.toolCalls) {
    const from = Math.round(((c.startMs ?? 0) / end) * width);
    const len = Math.max(1, Math.round(((c.ms ?? 0) / end) * width));
    const bar = " ".repeat(from) + (c.status === "interrupted" ? "~".repeat(len) : "█".repeat(len));
    const color = c.status === "completed" ? green : c.status === "interrupted" ? yellow : red;
    console.log(`  ${c.tool.replace(/^tools\./, "").padEnd(16)} ${color(bar.padEnd(width))} ${dim(c.status === "completed" ? `${c.ms}ms` : c.status)}`);
  }
}
console.log();
if (r.ok) console.log(green("✓ ") + JSON.stringify(r.value, null, 2));
else console.log(red(`✗ ${r.error.kind}: `) + r.error.message);
for (const w of r.warnings ?? []) console.log(yellow(`⚠ ${w}`));
console.log(dim(`\n${r.stats.ms} ms · ${r.stats.steps.toLocaleString()} steps · ${r.stats.slices} yields to host · ${r.toolCalls.length} calls`));
