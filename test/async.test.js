import { test } from "node:test";
import assert from "node:assert/strict";
import { run, value } from "./helpers.js";

test("tool calls are awaited and return plain data", async () => {
  assert.equal(await value("await tools.math.add({ a: 2, b: 3 })"), 5);
});

test("microtask ordering matches JavaScript", async () => {
  const code = `
    const log = [];
    const p = Promise.resolve();
    p.then(() => log.push('a')).then(() => log.push('c'));
    p.then(() => log.push('b'));
    log.push('sync');
    await p; await p; await p;
    log`;
  assert.deepEqual(await value(code), ["sync", "a", "b", "c"]);
});

test("async functions run synchronously until their first await", async () => {
  const code = `
    const log = [];
    const f = async () => { log.push('start'); await null; log.push('after await'); };
    const p = f();
    log.push('caller');
    await p;
    log`;
  assert.deepEqual(await value(code), ["start", "caller", "after await"]);
});

test("parallel tool calls really run in parallel", async () => {
  const r = await run("await Promise.all([1, 2, 3, 4, 5].map((n) => tools.slow.echo({ value: n, ms: 100 })))");
  assert.deepEqual(r.value, [1, 2, 3, 4, 5]);
  assert.ok(r.stats.ms < 300, `took ${r.stats.ms} ms`);
  // Every call records when it started, relative to the run (for timelines).
  for (const call of r.toolCalls) assert.ok(call.startMs >= 0 && call.startMs < 50, JSON.stringify(call));
});

test("a sync tool that throws is a rejected promise, not a crash", async () => {
  const { createRuntime } = await import("../src/index.js");
  const rt = createRuntime({ tools: { bad: { sync: { execute: () => { throw new Error("sync boom") } } } } });
  const r = await rt.execute("try { await tools.bad.sync() } catch (e) { return e.message }");
  assert.equal(r.value, "sync boom");
});

test("allSettled, race and any", async () => {
  const code = `
    const settled = await Promise.allSettled([tools.slow.echo({ value: 1 }), tools.slow.fail()]);
    const raced = await Promise.race([tools.slow.echo({ value: 'slow', ms: 80 }), tools.slow.echo({ value: 'fast', ms: 5 })]);
    const any = await Promise.any([tools.slow.fail(), tools.slow.echo({ value: 'ok' })]);
    ({ statuses: settled.map((s) => s.status), reason: settled[1].reason.message, raced, any })`;
  assert.deepEqual(await value(code), { statuses: ["fulfilled", "rejected"], reason: "the tool broke", raced: "fast", any: "ok" });
});

test("tool failures are catchable errors", async () => {
  assert.equal(await value("try { await tools.slow.fail() } catch (e) { return e.message }"), "the tool broke");
});

test("new Promise, then/catch/finally chains", async () => {
  const code = `
    const steps = [];
    const v = await new Promise((resolve) => resolve(1))
      .then((x) => { steps.push('then'); return x + 1 })
      .then(() => { throw new Error('bad') })
      .catch((e) => { steps.push('catch ' + e.message); return 10 })
      .finally(() => steps.push('finally'));
    ({ v, steps })`;
  assert.deepEqual(await value(code), { v: 10, steps: ["then", "catch bad", "finally"] });
});

test("async callbacks in map produce promises", async () => {
  assert.deepEqual(await value("await Promise.all([1, 2].map(async (x) => (await tools.math.add({ a: x, b: 1 })) * 10))"), [20, 30]);
});

test("unfinished calls are interrupted and reported", async () => {
  const r = await run("tools.slow.echo({ value: 1, ms: 200 }); 'returned early'");
  assert.equal(r.value, "returned early");
  assert.match(r.warnings[0], /still running/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(r.toolCalls[0].status, "interrupted");
});

test("an instant tool that wasn't awaited is recorded as completed, because it did run", async () => {
  const r = await run("tools.math.add({ a: 1, b: 2 }); tools.slow.echo({ value: 1, ms: 200 }); 'x'");
  assert.deepEqual(r.toolCalls.map((c) => c.status), ["completed", "interrupted"]);
  assert.match(r.warnings[0], /^1 call\(s\) were still running/);
});

test("unhandled rejections become warnings", async () => {
  const r = await run("tools.slow.fail(); await tools.slow.echo({ value: 1, ms: 30 }); 'done'");
  assert.equal(r.value, "done");
  assert.ok(r.warnings.some((w) => /Unhandled promise rejection: Error: the tool broke/.test(w)), r.warnings.join("\n"));
});

test("a promise that can never settle is reported as stuck, immediately", async () => {
  const r = await run("await new Promise(() => {})");
  assert.equal(r.error.kind, "Stuck");
  assert.ok(r.stats.ms < 100);
});

test("search finds tools and counts as a call", async () => {
  const r = await run("search('echo delay').items.map((t) => t.path)");
  assert.deepEqual(r.value, ["tools.slow.echo"]);
  assert.equal(r.toolCalls.length, 1);
});
