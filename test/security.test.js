import { test } from "node:test";
import assert from "node:assert/strict";
import { run, value } from "./helpers.js";

// Each attempt either throws or evaluates to something harmless.
// What matters: nothing ever hands back a host function or host object.
const attempts = {
  globalThis: "globalThis",
  process: "process.env",
  require: "require('fs')",
  importCall: "import('fs')",
  eval: "eval('1 + 1')",
  Function: "Function('return process')()",
  setTimeout: "setTimeout(() => {}, 1)",
  constructorOfObject: "({}).constructor",
  constructorOfArray: "[].constructor",
  constructorOfFunction: "(() => 1).constructor",
  constructorChain: "(() => 1).constructor.constructor('return process')()",
  toolConstructor: "tools.constructor.constructor('return process')()",
  builtinConstructor: "Math.max.constructor('return process')()",
  protoOfObject: "({}).__proto__",
  getPrototypeOf: "Object.getPrototypeOf({})",
  defineProperty: "Object.defineProperty({}, 'x', { get() { return 1 } })",
  consoleConstructor: "console.log.constructor",
  promiseConstructor: "Promise.resolve(1).constructor",
  errorStackHost: "new Error('x').stack",
  thisAtTopLevel: "this",
  argumentsCallee: "(function () { return arguments.callee })()",
};

for (const [name, code] of Object.entries(attempts)) {
  test(`escape attempt: ${name}`, async () => {
    const r = await run(code);
    if (r.ok) {
      // A harmless value: undefined/null, a string, or plain data.
      const v = r.value;
      assert.ok(v === null || typeof v === "string" || typeof v === "number" || typeof v === "object", `unexpected ${typeof v}`);
      assert.doesNotMatch(JSON.stringify(v), /node|darwin|linux|\/Users|PATH/i);
    } else {
      assert.match(r.error.kind, /ExecutionFailure|UnsupportedSyntax|ParseError/);
    }
  });
}

// Found while writing the playground examples: method tables were plain
// objects, so `({}).constructor` returned the host's Object function. Every
// property name of Object.prototype, on every kind of receiver, must give
// nothing (or one of our own built-ins), never a host value.
test("Object.prototype names never reach host values, on any receiver", async () => {
  const receivers = ["({})", "[]", "''", "(1)", "true", "Promise.resolve()", "new Map()", "new Set()", "new Date(0)", "/x/", "(() => 1)", "Math.max", "tools", "tools.math.add", "new Error('x')"];
  const names = Object.getOwnPropertyNames(Object.prototype).concat(Object.getOwnPropertyNames(Function.prototype));
  const code = `
    const receivers = [${receivers.join(", ")}];
    const names = ${JSON.stringify(names)};
    const found = [];
    for (const r of receivers) for (const n of names) {
      let v;
      try { v = r[n] } catch (e) { continue }
      const t = typeof v;
      if (t === 'undefined') continue;
      found.push(t + ':' + n);
    }
    found`;
  const r = await run(code);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  // Allowed: our own toString/hasOwnProperty/valueOf/call/apply/bind built-ins,
  // tool references (any name under tools is a path), and `name`/`length`.
  const allowed = /^(function:(toString|hasOwnProperty|valueOf|call|apply|bind|toLocaleString)|number:length|string:name|function:.*)$/;
  for (const f of r.value) assert.match(f, allowed);
  // And none of them is a host function: calling `constructor` is never possible.
  const r2 = await run("[({}).constructor, [].constructor, ''.constructor, (1).constructor, ({}).__proto__, [].__proto__, Promise.resolve().constructor].map((x) => typeof x)");
  assert.deepEqual(r2.value, Array(7).fill("undefined"));
});

test("host-side check: getProp only ever returns guest values", async () => {
  const { Interpreter } = await import("../src/interpreter.js");
  const { makeGlobals } = await import("../src/builtins.js");
  const V = await import("../src/values.js");
  const ours = [V.GObj, V.GArr, V.GFn, V.NFn, V.GBound, V.GPromise, V.ToolRef, V.GMap, V.GSet, V.GDate, V.GRegExp];
  const isGuest = (v) => v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v) || ours.some((C) => v instanceof C);
  const interp = new Interpreter({ host: { alloc() {}, log() {}, search() {}, callTool() {} }, globals: (i) => makeGlobals(i) });
  const receivers = ["", 1, true, new V.GObj(), new V.GArr([1]), new V.GPromise(), new V.GMap(), new V.GSet(), new V.GDate(0), new V.GRegExp("x", ""), new V.ToolRef([]), interp.root.lookup("Math").value, interp.root.lookup("Promise").value, interp.root.lookup("JSON").value];
  const names = new Set([
    ...Object.getOwnPropertyNames(Object.prototype), ...Object.getOwnPropertyNames(Function.prototype),
    ...Object.getOwnPropertyNames(Array.prototype), ...Object.getOwnPropertyNames(String.prototype),
    ...Object.getOwnPropertyNames(Promise.prototype), "prototype", "caller", "callee",
  ]);
  for (const r of receivers) {
    for (const n of names) {
      let v;
      try {
        v = interp.getProp(r, n);
      } catch {
        continue;
      }
      assert.ok(isGuest(v), `${r?.constructor?.name ?? typeof r}.${n} leaked a host value: ${String(v).slice(0, 40)}`);
    }
  }
});

test("there is no way to name a host global", async () => {
  const r = await run("[typeof process, typeof require, typeof globalThis, typeof eval, typeof Function, typeof setTimeout, typeof Buffer]");
  assert.deepEqual(r.value, Array(7).fill("undefined"));
});

test("__proto__ is just a key: no prototype pollution inside", async () => {
  assert.deepEqual(await value("const o = JSON.parse('{\"__proto__\": {\"polluted\": true}}'); const p = {}; [o.__proto__.polluted, p.polluted]"), [true, null]);
});

test("__proto__ keys are dropped at the host boundary", async () => {
  const r = await value(`await tools.host.inspect(JSON.parse('{"__proto__": {"polluted": true}, "a": 1}'))`);
  assert.deepEqual(r, { keys: ["a"], protoIsObject: true, polluted: false });
  assert.equal({}.polluted, undefined);
});

test("host results arrive as plain data, never as host objects", async () => {
  const r = await value("const x = await tools.host.leaky(); [typeof x.fn, x.date, x.nested.ok, x.proto.inherited]");
  assert.deepEqual(r, ["undefined", "1970-01-01T00:00:00.000Z", true, null]);
});

test("tool inputs are copies: the host can't mutate guest objects", async () => {
  assert.deepEqual(await value("const o = { a: 1, b: 2 }; await tools.math.add(o); o"), { a: 1, b: 2 });
});

test("guest functions can't be sent to the host", async () => {
  const r = await value("await tools.host.inspect({ f: () => 1, keep: 1 })");
  assert.deepEqual(r.keys, ["keep"]);
});

test("a stray await on a tool reference doesn't call it", async () => {
  const r = await run("const t = await tools.math.add; typeof t");
  assert.equal(r.value, "function");
  assert.equal(r.toolCalls.length, 0);
});

test("built-ins can't be replaced", async () => {
  const r = await run("JSON = null");
  assert.equal(r.ok, false);
  assert.match(r.error.message, /built-in/);
  const r2 = await run("Math.max = () => 0; Math.max(1, 2)");
  assert.equal(r2.ok, false);
});
