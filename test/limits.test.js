import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./helpers.js";

test("an infinite loop hits the timeout", async () => {
  const r = await run("while (true) {}", { limits: { timeoutMs: 200 } });
  assert.equal(r.error.kind, "TimeoutExceeded");
  assert.ok(r.stats.ms < 400, `took ${r.stats.ms}`);
});

test("an infinite loop doesn't block the host event loop", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  await run("let n = 0; while (true) n++", { limits: { timeoutMs: 300 } });
  clearInterval(timer);
  assert.ok(ticks >= 15, `host timer only ran ${ticks} times in 300 ms`);
});

test("an AbortSignal stops a run", async () => {
  const { createRuntime } = await import("../src/index.js");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const r = await createRuntime().execute("while (true) {}", { signal: controller.signal });
  assert.equal(r.error.kind, "Interrupted");
});

test("deep recursion is a catchable RangeError", async () => {
  const r = await run("const f = (n) => f(n + 1); try { f(0) } catch (e) { return e.name + ': ' + e.message }");
  assert.equal(r.value, "RangeError: Maximum call stack size exceeded");
});

test("tool call limit", async () => {
  const r = await run("for (let i = 0; i < 10; i++) await tools.math.add({ a: i, b: i })", { limits: { maxToolCalls: 3 } });
  assert.equal(r.error.kind, "ToolCallLimitExceeded");
  assert.equal(r.toolCalls.length, 3);
});

test("huge strings are refused per operation", async () => {
  const r = await run("try { 'x'.repeat(2 ** 25) } catch (e) { return e.name }");
  assert.equal(r.value, "RangeError");
});

test("huge arrays are refused per operation", async () => {
  const r = await run("try { new Array(2 ** 30) } catch (e) { return e.name }");
  assert.equal(r.value, "RangeError");
});

test("a memory bomb is stopped by the memory limit, not the OS", async () => {
  const code = "const parts = []; for (let i = 0; i < 1e9; i++) parts.push('x'.repeat(1e6) + i); parts.length";
  const r = await run(code, { limits: { maxHeapGrowthMB: 128, timeoutMs: 20_000 } });
  assert.equal(r.error.kind, "MemoryLimit");
  assert.ok(r.stats.ms < 5000, `took ${r.stats.ms}`);
});

test("too many promises", async () => {
  const r = await run("const ps = []; for (let i = 0; i < 20000; i++) ps.push(new Promise(() => {})); 1");
  assert.equal(r.error.kind, "ResourceLimit");
});

test("big results are truncated with a marker", async () => {
  const r = await run("'y'.repeat(100000)", { limits: { maxOutputBytes: 1000 } });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.match(r.value, /truncated/);
});

test("logs are capped too", async () => {
  const r = await run("for (let i = 0; i < 1000; i++) console.log('line ' + i)", { limits: { maxOutputBytes: 200 } });
  assert.equal(r.truncated, true);
  assert.ok(r.logs.length < 50);
});

test("catch and finally can't swallow a timeout", async () => {
  const r = await run("while (true) { try { while (true) {} } catch (e) {} finally { } }", { limits: { timeoutMs: 200 } });
  assert.equal(r.error.kind, "TimeoutExceeded");
});
