import { createRuntime } from "../src/index.js";
const rt = createRuntime();
for (const [name, code] of Object.entries({
  "arrow, block body": "let d = 0; const f = (n) => { d = n; return f(n + 1) }; try { f(0) } catch (e) {} ; d",
  "arrow, expression body": "let d = 0; const f = (n) => (d = n, f(n + 1)); try { f(0) } catch (e) {} ; d",
  "through map callback": "let d = 0; function f(n) { d = n; return [n].map((x) => f(x + 1))[0] } try { f(0) } catch (e) {} ; d",
})) {
  const r = await rt.execute(code);
  console.log(name.padEnd(24), r.ok ? r.value : r.error.message);
}
