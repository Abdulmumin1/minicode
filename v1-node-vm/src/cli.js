// Usage:
//   node src/cli.js examples/02-tools.js
//   echo 'return 1 + 1' | node src/cli.js

import { readFileSync } from "node:fs";
import { runCode } from "./sandbox.js";

const file = process.argv[2];
const code = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");

const out = await runCode(code, { allowedFetchHosts: ["api.github.com"] });

for (const log of out.logs) console.log(`[${log.level}]`, log.text);
if (out.calls.length) {
  console.log("\nTool calls:");
  for (const c of out.calls) {
    const status = c.ok ? "ok" : `error: ${c.error}`;
    console.log(`  ${c.path}(${JSON.stringify(c.args)})  ${c.ms}ms  ${status}`);
  }
}
console.log(out.ok ? "\nResult:" : "\nError:");
console.log(out.ok ? JSON.stringify(out.result, null, 2) : out.error);
console.log(`\n(${out.ms}ms)`);
