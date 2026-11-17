import { test } from "node:test";
import assert from "node:assert/strict";
import { run, value } from "./helpers.js";

const cases = [
  ["arithmetic", "1 + 2 * 3 - 4 / 2", 5],
  ["string concat", "'a' + 1 + 2", "a12"],
  ["final expression is the result", "const x = 40; x + 2", 42],
  ["explicit return", "return 'hi'", "hi"],
  ["no value becomes null", "const x = 1;", null],
  ["template literal", "const n = 3; `n=${n * 2}`", "n=6"],
  ["closures capture per-iteration let", "const fs = []; for (let i = 0; i < 3; i++) fs.push(() => i); fs.map((f) => f())", [0, 1, 2]],
  ["var is function-scoped", "function f() { if (true) { var x = 5 } return x } f()", 5],
  ["hoisted function declaration", "f(); function f() { return 7 } f()", 7],
  ["recursion", "const fib = (n) => n < 2 ? n : fib(n - 1) + fib(n - 2); fib(15)", 610],
  ["object destructuring with rest", "const { a, ...rest } = { a: 1, b: 2, c: 3 }; ({ a, rest })", { a: 1, rest: { b: 2, c: 3 } }],
  ["array destructuring with defaults", "const [x, , z = 9, ...r] = [1, 2]; [x, z, r]", [1, 9, []]],
  ["nested defaults in params", "const f = ({ a = 1, b: { c } = { c: 2 } } = {}) => a + c; f()", 3],
  ["spread", "const a = [1, 2]; const o = { x: 1 }; [...a, 3, Math.max(...a), { ...o, y: 2 }]", [1, 2, 3, 2, { x: 1, y: 2 }]],
  ["optional chaining", "const o = { a: null }; [o?.a?.b, o.a?.b.c.d, o.f?.(), o?.['a']]", [null, null, null, null]],
  ["nullish and logical assignment", "let a = null; a ??= 5; let b = 0; b ||= 7; let c = 1; c &&= 9; [a, b, c]", [5, 7, 9]],
  ["labels", "let n = 0; outer: for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { if (j == 1) continue outer; n++ } n", 3],
  ["switch with fallthrough", "const f = (x) => { switch (x) { case 1: case 2: return 'low'; case 3: return 'three'; default: return 'other' } }; [f(1), f(2), f(3), f(9)]", ["low", "low", "three", "other"]],
  ["try/catch/finally", "const log = []; try { throw new Error('x') } catch (e) { log.push(e.message) } finally { log.push('f') } log", ["x", "f"]],
  ["finally overrides return", "const f = () => { try { return 1 } finally { return 2 } }; f()", 2],
  ["this in methods", "const o = { v: 4, f() { return this.v }, g: function () { return this.v } }; [o.f(), o.g()]", [4, 4]],
  ["arrow this is lexical", "const o = { v: 4, f() { return [1].map(() => this.v) } }; o.f()", [4]],
  ["typeof", "[typeof 1, typeof 'a', typeof null, typeof undefined, typeof {}, typeof [], typeof (() => 1), typeof nope]", ["number", "string", "object", "undefined", "object", "object", "function", "undefined"]],
  ["instanceof", "[new TypeError('x') instanceof Error, [] instanceof Array, new Map() instanceof Map, {} instanceof Array]", [true, true, true, false]],
  ["in and delete", "const o = { a: 1, b: 2 }; delete o.a; ['a' in o, 'b' in o, Object.keys(o)]", [false, true, ["b"]]],
  ["for...in and for...of", "const out = []; for (const k in { a: 1, b: 2 }) out.push(k); for (const [k, v] of Object.entries({ c: 3 })) out.push(k + v); out", ["a", "b", "c3"]],
  ["array methods", "[3, 1, 2].sort((a, b) => a - b).concat([4]).filter((x) => x > 1).map((x) => x * 10).slice(1)", [30, 40]],
  ["sort is stable and default sort is by string", "[10, 9, 1, 100].sort()", [1, 10, 100, 9]],
  ["reduce", "[1, 2, 3, 4].reduce((a, b) => a + b)", 10],
  ["flat and flatMap", "[[1, [2]], 3].flat(2).flatMap((x) => [x, x])", [1, 1, 2, 2, 3, 3]],
  ["string methods", "' Hello '.trim().toLowerCase().padStart(7, '*').split('l')", ["**he", "", "o"]],
  ["replace with callback", "'a1b22'.replace(/\\d+/g, (m) => `<${m.length}>`)", "a<1>b<2>"],
  ["regex groups", "const m = '2026-11-17'.match(/(?<y>\\d+)-(\\d+)/); [m.groups.y, m[2], m.index]", ["2026", "11", 0]],
  ["Map and Set", "const m = new Map([['a', 1]]); m.set('b', 2); const s = new Set([1, 1, 2]); [m.get('b'), m.size, [...m.keys()], [...s], s.has(2)]", [2, 2, ["a", "b"], [1, 2], true]],
  ["JSON round trip", "JSON.parse(JSON.stringify({ d: new Date(0), n: [1, null], u: undefined, f() {} }))", { d: "1970-01-01T00:00:00.000Z", n: [1, null] }],
  ["JSON indent", "JSON.stringify({ a: [1] }, null, 2)", '{\n  "a": [\n    1\n  ]\n}'],
  ["Object helpers", "Object.fromEntries(Object.entries({ a: 1, b: 2 }).map(([k, v]) => [k.toUpperCase(), v * 2]))", { A: 2, B: 4 }],
  ["Object.groupBy", "Object.groupBy([1, 2, 3, 4], (n) => n % 2 ? 'odd' : 'even')", { odd: [1, 3], even: [2, 4] }],
  ["Array.from with length", "Array.from({ length: 3 }, (_, i) => i * i)", [0, 1, 4]],
  ["Number formatting", "[(3.14159).toFixed(2), (255).toString(16), (1234567.891).toLocaleString('en-US'), parseInt('42px')]", ["3.14", "ff", "1,234,567.891", 42]],
  ["Date", "const d = new Date('2026-01-02T03:04:05Z'); [d.getUTCFullYear(), d.toISOString(), typeof Date.now()]", [2026, "2026-01-02T03:04:05.000Z", "number"]],
  ["bind/call/apply", "function f(a, b) { return this.x + a + b } const o = { x: 1 }; [f.call(o, 2, 3), f.apply(o, [2, 3]), f.bind(o, 2)(3)]", [6, 6, 6]],
  ["loose equality", "[null == undefined, 1 == '1', 0 == '', null == 0]", [true, true, true, false]],
  ["arguments", "function f() { return arguments.length } f(1, 2, 3)", 3],
  ["frozen object", "const o = Object.freeze({ a: 1 }); try { o.a = 2 } catch (e) { return e.name }", "TypeError"],
];

for (const [name, code, expected] of cases) {
  test(name, async () => {
    assert.deepEqual(await value(code), expected);
  });
}

test("unsupported syntax fails before anything runs", async () => {
  for (const code of ["class A {}", "function* g() {}", "({ get x() { return 1 } })", "10n", "import x from 'fs'", "with (o) {}"]) {
    const r = await run(`await tools.math.add({ a: 1, b: 2 });\n${code}`);
    assert.equal(r.ok, false, code);
    assert.match(r.error.kind, /UnsupportedSyntax|ParseError/, code);
    assert.equal(r.toolCalls.length, 0, `no tool should run for: ${code}`);
  }
});

test("errors carry a line number", async () => {
  const r = await run("const a = 1;\nconst b = 2;\nnull.boom");
  assert.equal(r.ok, false);
  assert.match(r.error.message, /Cannot read properties of null \(reading 'boom'\) \(line 3/);
});

test("undeclared assignment is an error, not a global", async () => {
  const r = await run("leak = 1");
  assert.equal(r.ok, false);
  assert.match(r.error.message, /ReferenceError: leak is not defined/);
});

test("console output is captured", async () => {
  const r = await run("console.log('a', { b: 1 }, [2]); console.warn('careful'); 1");
  assert.deepEqual(r.logs, ['a {"b":1} [2]', "[warn] careful"]);
});
