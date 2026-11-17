// The guest standard library. Only what is written here exists.
// Every built-in is a generator `function* (interp, thisValue, args)`.

import {
  GArr, GBound, GDate, GError, GFn, GMap, GObj, GPromise, GRegExp, GSet, GuestThrow, NFn, ToolRef, isCallable,
} from "./values.js";
import { MAX_ARRAY_LENGTH, isIndex, strictEquals, toNumber, truthy } from "./interpreter.js";

const fn = (name, impl, opts) => new NFn(name, impl, opts);

// A built-in that never calls back into guest code.
const pure = (name, f) => fn(name, function* (interp, self, args) {
  return f(interp, self, args);
});

// ---------------------------------------------------------------------------
// JSON (guest values <-> text), shared with console and the host boundary
// ---------------------------------------------------------------------------

export function guestToJsonText(interp, value, indent = "") {
  const seen = new Set();
  const out = (v, depth, pad) => {
    if (v === null || v === undefined) return v === null ? "null" : undefined;
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
    if (typeof v === "boolean") return String(v);
    if (isCallable(v)) return undefined;
    if (v instanceof GDate) return Number.isNaN(v.time) ? "null" : JSON.stringify(new Date(v.time).toISOString());
    if (v instanceof GPromise) interp.typeError("Cannot serialize a Promise. Did you forget to `await` it?");
    if (seen.has(v)) interp.typeError("Converting circular structure to JSON");
    seen.add(v);
    const inner = pad + indent;
    const sep = indent ? ",\n" + inner : ",";
    const open = indent ? "\n" + inner : "";
    const close = indent ? "\n" + pad : "";
    let text;
    if (v instanceof GArr) {
      const parts = v.items.map((x) => out(x, depth + 1, inner) ?? "null");
      text = parts.length ? `[${open}${parts.join(sep)}${close}]` : "[]";
    } else if (v instanceof GSet) {
      const parts = [...v.set].map((x) => out(x, depth + 1, inner) ?? "null");
      text = parts.length ? `[${open}${parts.join(sep)}${close}]` : "[]";
    } else if (v instanceof GObj) {
      const parts = [];
      for (const [k, x] of v.props) {
        const s = out(x, depth + 1, inner);
        if (s !== undefined) parts.push(`${JSON.stringify(k)}:${indent ? " " : ""}${s}`);
      }
      text = parts.length ? `{${open}${parts.join(sep)}${close}}` : "{}";
    } else {
      text = "{}"; // Map, RegExp, ...: what JSON.stringify gives in JS
    }
    seen.delete(v);
    interp.checkString(text);
    return text;
  };
  return out(value, 0, "");
}

export function jsonToGuest(x) {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return new GArr(x.map(jsonToGuest));
  const o = new GObj();
  for (const [k, v] of Object.entries(x)) o.props.set(k, jsonToGuest(v));
  return o;
}

// How console.log shows a value.
export function display(interp, v) {
  if (typeof v === "string") return v;
  if (v instanceof GError) return `${interp.toStr(v.name)}: ${interp.toStr(v.message)}`;
  if (v instanceof GMap) return `Map(${v.map.size})`;
  if (v instanceof GSet) return `Set(${v.set.size}) ${guestToJsonText(interp, v)}`;
  if (v instanceof GPromise) return `Promise { <${v.state}> }`;
  if (isCallable(v)) return `[Function ${v.name || "anonymous"}]`;
  try {
    return guestToJsonText(interp, v) ?? String(v);
  } catch {
    return interp.toStr(v);
  }
}

// ---------------------------------------------------------------------------
// Helpers for methods that take guest callbacks
// ---------------------------------------------------------------------------

function callback(interp, f, name) {
  if (!isCallable(f)) interp.typeError(`${interp.toStr(f)} is not a function (in ${name})`);
  return f;
}

function* sortItems(interp, items, cmp) {
  const compare = cmp === undefined
    ? function* (a, b) {
      if (a === undefined) return b === undefined ? 0 : 1;
      if (b === undefined) return -1;
      const sa = interp.toStr(a);
      const sb = interp.toStr(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    : function* (a, b) {
      if (a === undefined) return b === undefined ? 0 : 1;
      if (b === undefined) return -1;
      return toNumber(yield* interp.callFunction(cmp, undefined, [a, b]));
    };
  // Merge sort: stable, and every comparison can be paused.
  const merge = function* (arr) {
    if (arr.length <= 1) return arr;
    const mid = arr.length >> 1;
    const left = yield* merge(arr.slice(0, mid));
    const right = yield* merge(arr.slice(mid));
    const out = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      if ((yield* compare(left[i], right[j])) <= 0) out.push(left[i++]);
      else out.push(right[j++]);
    }
    while (i < left.length) out.push(left[i++]);
    while (j < right.length) out.push(right[j++]);
    return out;
  };
  return yield* merge(items);
}

function relIndex(n, len, dflt) {
  if (n === undefined) return dflt;
  n = Math.trunc(toNumber(n)) || 0;
  return n < 0 ? Math.max(len + n, 0) : Math.min(n, len);
}

function flatten(items, depth, out) {
  for (const x of items) {
    if (x instanceof GArr && depth > 0) flatten(x.items, depth - 1, out);
    else out.push(x);
  }
  return out;
}

function matchToGuest(m) {
  if (!m) return null;
  const arr = new GArr([...m]);
  arr.extra = new Map([["index", m.index], ["input", m.input]]);
  if (m.groups) {
    const g = new GObj();
    for (const [k, v] of Object.entries(m.groups)) g.props.set(k, v);
    arr.extra.set("groups", g);
  } else {
    arr.extra.set("groups", undefined);
  }
  return arr;
}

const toRegExp = (interp, v) => (v instanceof GRegExp ? v.re : String(interp.toStr(v)));

// ---------------------------------------------------------------------------
// Methods by receiver kind
// ---------------------------------------------------------------------------

function arrayMethods() {
  const items = (interp, self) => self.items;
  const each = (name, body) => fn(name, function* (interp, self, [f, thisArg]) {
    callback(interp, f, `Array.prototype.${name}`);
    return yield* body(interp, self, f, thisArg);
  });
  const grow = (interp, arr, extra) => {
    if (arr.length + extra > MAX_ARRAY_LENGTH) interp.throwError("RangeError", "Invalid array length");
    interp.host.alloc(extra * 8);
  };
  return {
    push: pure("push", (interp, self, args) => {
      grow(interp, self.items, args.length);
      self.items.push(...args);
      return self.items.length;
    }),
    pop: pure("pop", (i, self) => self.items.pop()),
    shift: pure("shift", (i, self) => self.items.shift()),
    unshift: pure("unshift", (interp, self, args) => {
      grow(interp, self.items, args.length);
      return self.items.unshift(...args);
    }),
    slice: pure("slice", (interp, self, [a, b]) => {
      const len = self.items.length;
      return new GArr(self.items.slice(relIndex(a, len, 0), relIndex(b, len, len)));
    }),
    splice: pure("splice", (interp, self, [start, count, ...add]) => {
      const len = self.items.length;
      const s = relIndex(start, len, 0);
      const c = count === undefined ? len - s : Math.max(0, Math.min(Math.trunc(toNumber(count)) || 0, len - s));
      grow(interp, self.items, add.length);
      return new GArr(self.items.splice(s, c, ...add));
    }),
    concat: pure("concat", (interp, self, args) => {
      const out = self.items.slice();
      for (const a of args) {
        if (a instanceof GArr) out.push(...a.items);
        else out.push(a);
      }
      grow(interp, [], out.length);
      return new GArr(out);
    }),
    join: pure("join", (interp, self, [sep]) => {
      const s = sep === undefined ? "," : interp.toStr(sep);
      const text = self.items.map((x) => (x === null || x === undefined ? "" : interp.toStr(x))).join(s);
      interp.host.alloc(text.length * 2);
      return interp.checkString(text);
    }),
    indexOf: pure("indexOf", (interp, self, [x, from]) => self.items.indexOf(x, from === undefined ? 0 : toNumber(from))),
    lastIndexOf: pure("lastIndexOf", (interp, self, [x]) => self.items.lastIndexOf(x)),
    includes: pure("includes", (interp, self, [x]) => self.items.includes(x)),
    reverse: pure("reverse", (interp, self) => {
      self.items.reverse();
      return self;
    }),
    at: pure("at", (interp, self, [n]) => self.items.at(Math.trunc(toNumber(n ?? 0)) || 0)),
    fill: pure("fill", (interp, self, [v, a, b]) => {
      const len = self.items.length;
      self.items.fill(v, relIndex(a, len, 0), relIndex(b, len, len));
      return self;
    }),
    flat: pure("flat", (interp, self, [d]) => new GArr(flatten(self.items, d === undefined ? 1 : toNumber(d), []))),
    keys: pure("keys", (interp, self) => new GArr(self.items.map((_, i) => i))),
    values: pure("values", (interp, self) => new GArr(self.items.slice())),
    entries: pure("entries", (interp, self) => new GArr(self.items.map((v, i) => new GArr([i, v])))),
    toString: pure("toString", (interp, self) => interp.toStr(self)),
    forEach: each("forEach", function* (interp, self, f, t) {
      const arr = self.items;
      for (let i = 0; i < arr.length; i++) yield* interp.callFunction(f, t, [arr[i], i, self]);
      return undefined;
    }),
    map: each("map", function* (interp, self, f, t) {
      const arr = self.items;
      const out = [];
      for (let i = 0; i < arr.length; i++) out.push(yield* interp.callFunction(f, t, [arr[i], i, self]));
      interp.host.alloc(out.length * 8);
      return new GArr(out);
    }),
    filter: each("filter", function* (interp, self, f, t) {
      const arr = self.items;
      const out = [];
      for (let i = 0; i < arr.length; i++) if (truthy(yield* interp.callFunction(f, t, [arr[i], i, self]))) out.push(arr[i]);
      return new GArr(out);
    }),
    flatMap: each("flatMap", function* (interp, self, f, t) {
      const arr = self.items;
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const r = yield* interp.callFunction(f, t, [arr[i], i, self]);
        if (r instanceof GArr) out.push(...r.items);
        else out.push(r);
      }
      return new GArr(out);
    }),
    find: each("find", function* (interp, self, f, t) {
      const arr = self.items;
      for (let i = 0; i < arr.length; i++) if (truthy(yield* interp.callFunction(f, t, [arr[i], i, self]))) return arr[i];
      return undefined;
    }),
    findIndex: each("findIndex", function* (interp, self, f, t) {
      const arr = self.items;
      for (let i = 0; i < arr.length; i++) if (truthy(yield* interp.callFunction(f, t, [arr[i], i, self]))) return i;
      return -1;
    }),
    findLast: each("findLast", function* (interp, self, f, t) {
      const arr = self.items;
      for (let i = arr.length - 1; i >= 0; i--) if (truthy(yield* interp.callFunction(f, t, [arr[i], i, self]))) return arr[i];
      return undefined;
    }),
    findLastIndex: each("findLastIndex", function* (interp, self, f, t) {
      const arr = self.items;
      for (let i = arr.length - 1; i >= 0; i--) if (truthy(yield* interp.callFunction(f, t, [arr[i], i, self]))) return i;
      return -1;
    }),
    some: each("some", function* (interp, self, f, t) {
      const arr = self.items;
      for (let i = 0; i < arr.length; i++) if (truthy(yield* interp.callFunction(f, t, [arr[i], i, self]))) return true;
      return false;
    }),
    every: each("every", function* (interp, self, f, t) {
      const arr = self.items;
      for (let i = 0; i < arr.length; i++) if (!truthy(yield* interp.callFunction(f, t, [arr[i], i, self]))) return false;
      return true;
    }),
    reduce: fn("reduce", function* (interp, self, args) {
      const f = callback(interp, args[0], "Array.prototype.reduce");
      const arr = self.items;
      let i = 0;
      let acc;
      if (args.length > 1) acc = args[1];
      else if (arr.length === 0) interp.typeError("Reduce of empty array with no initial value");
      else acc = arr[i++];
      for (; i < arr.length; i++) acc = yield* interp.callFunction(f, undefined, [acc, arr[i], i, self]);
      return acc;
    }),
    reduceRight: fn("reduceRight", function* (interp, self, args) {
      const f = callback(interp, args[0], "Array.prototype.reduceRight");
      const arr = self.items;
      let i = arr.length - 1;
      let acc;
      if (args.length > 1) acc = args[1];
      else if (arr.length === 0) interp.typeError("Reduce of empty array with no initial value");
      else acc = arr[i--];
      for (; i >= 0; i--) acc = yield* interp.callFunction(f, undefined, [acc, arr[i], i, self]);
      return acc;
    }),
    sort: fn("sort", function* (interp, self, [cmp]) {
      if (cmp !== undefined) callback(interp, cmp, "Array.prototype.sort");
      const sorted = yield* sortItems(interp, self.items.slice(), cmp);
      self.items.splice(0, self.items.length, ...sorted);
      return self;
    }),
    toSorted: fn("toSorted", function* (interp, self, [cmp]) {
      if (cmp !== undefined) callback(interp, cmp, "Array.prototype.toSorted");
      return new GArr(yield* sortItems(interp, self.items.slice(), cmp));
    }),
    toReversed: pure("toReversed", (interp, self) => new GArr(self.items.slice().reverse())),
  };
}

function stringMethods() {
  const s = (name, f) => pure(name, (interp, self, args) => f(self, args, interp));
  const sized = (interp, out) => {
    interp.checkString(out);
    interp.host.alloc(out.length * 2);
    return out;
  };
  return {
    at: s("at", (str, [n]) => str.at(Math.trunc(toNumber(n ?? 0)) || 0)),
    charAt: s("charAt", (str, [n]) => str.charAt(toNumber(n ?? 0))),
    charCodeAt: s("charCodeAt", (str, [n]) => str.charCodeAt(toNumber(n ?? 0))),
    codePointAt: s("codePointAt", (str, [n]) => str.codePointAt(toNumber(n ?? 0))),
    includes: s("includes", (str, [x, p]) => str.includes(String(x), p)),
    startsWith: s("startsWith", (str, [x, p]) => str.startsWith(String(x), p)),
    endsWith: s("endsWith", (str, [x, p]) => str.endsWith(String(x), p)),
    indexOf: s("indexOf", (str, [x, p]) => str.indexOf(String(x), p)),
    lastIndexOf: s("lastIndexOf", (str, [x]) => str.lastIndexOf(String(x))),
    slice: s("slice", (str, [a, b]) => str.slice(a, b)),
    substring: s("substring", (str, [a, b]) => str.substring(a, b)),
    substr: s("substr", (str, [a, b]) => str.substr(a, b)),
    toUpperCase: s("toUpperCase", (str) => str.toUpperCase()),
    toLowerCase: s("toLowerCase", (str) => str.toLowerCase()),
    toLocaleUpperCase: s("toLocaleUpperCase", (str) => str.toUpperCase()),
    toLocaleLowerCase: s("toLocaleLowerCase", (str) => str.toLowerCase()),
    trim: s("trim", (str) => str.trim()),
    trimStart: s("trimStart", (str) => str.trimStart()),
    trimEnd: s("trimEnd", (str) => str.trimEnd()),
    padStart: s("padStart", (str, [n, f], interp) => {
      if (toNumber(n) > (1 << 24)) interp.throwError("RangeError", "Invalid string length");
      return sized(interp, str.padStart(toNumber(n), f === undefined ? " " : String(f)));
    }),
    padEnd: s("padEnd", (str, [n, f], interp) => {
      if (toNumber(n) > (1 << 24)) interp.throwError("RangeError", "Invalid string length");
      return sized(interp, str.padEnd(toNumber(n), f === undefined ? " " : String(f)));
    }),
    repeat: s("repeat", (str, [n], interp) => {
      const count = toNumber(n);
      if (count < 0 || !Number.isFinite(count)) interp.throwError("RangeError", `Invalid count value: ${count}`);
      if (str.length * count > (1 << 24)) interp.throwError("RangeError", "Invalid string length");
      return sized(interp, str.repeat(count));
    }),
    concat: s("concat", (str, args, interp) => sized(interp, str + args.map((a) => interp.toStr(a)).join(""))),
    split: s("split", (str, [sep, limit], interp) => {
      const parts = sep === undefined ? [str] : str.split(toRegExp(interp, sep), limit);
      interp.checkArrayLength(parts.length);
      interp.host.alloc(parts.length * 16);
      return new GArr(parts);
    }),
    localeCompare: s("localeCompare", (str, [other]) => str.localeCompare(String(other))),
    normalize: s("normalize", (str, [form]) => str.normalize(form)),
    match: s("match", (str, [re], interp) => {
      const r = toRegExp(interp, re);
      if (r instanceof RegExp && r.global) {
        const all = str.match(r);
        return all ? new GArr(all) : null;
      }
      return matchToGuest(str.match(r));
    }),
    matchAll: s("matchAll", (str, [re], interp) => {
      const r = toRegExp(interp, re);
      if (!(r instanceof RegExp) || !r.global) interp.typeError("matchAll requires a global RegExp (add the g flag)");
      return new GArr([...str.matchAll(r)].map(matchToGuest));
    }),
    search: s("search", (str, [re], interp) => str.search(toRegExp(interp, re))),
    toString: s("toString", (str) => str),
    valueOf: s("valueOf", (str) => str),
    replace: fn("replace", function* (interp, str, [pattern, replacement]) {
      return yield* replace(interp, str, pattern, replacement, false);
    }),
    replaceAll: fn("replaceAll", function* (interp, str, [pattern, replacement]) {
      if (pattern instanceof GRegExp && !pattern.re.global) interp.typeError("replaceAll must be called with a global RegExp");
      return yield* replace(interp, str, pattern, replacement, true);
    }),
  };
}

function* replace(interp, str, pattern, replacement, all) {
  const re = pattern instanceof GRegExp ? pattern.re : null;
  if (!isCallable(replacement)) {
    const rep = interp.toStr(replacement);
    const out = re ? str.replace(re, rep) : all ? str.replaceAll(interp.toStr(pattern), rep) : str.replace(interp.toStr(pattern), rep);
    return interp.checkString(out);
  }
  // A guest callback: find the matches on the host, call back for each one.
  const matches = [];
  if (re) {
    if (re.global) for (const m of str.matchAll(re)) matches.push(m);
    else {
      const m = re.exec(str);
      re.lastIndex = 0;
      if (m) matches.push(m);
    }
  } else {
    const needle = interp.toStr(pattern);
    let from = 0;
    while (true) {
      const i = str.indexOf(needle, from);
      if (i < 0) break;
      const m = [needle];
      m.index = i;
      matches.push(m);
      if (!all) break;
      from = i + Math.max(needle.length, 1);
    }
  }
  let out = "";
  let last = 0;
  for (const m of matches) {
    const args = [...m, m.index, str];
    if (m.groups) {
      const g = new GObj();
      for (const [k, v] of Object.entries(m.groups)) g.props.set(k, v);
      args.push(g);
    }
    out += str.slice(last, m.index) + interp.toStr(yield* interp.callFunction(replacement, undefined, args));
    last = m.index + m[0].length;
    interp.checkString(out);
  }
  return out + str.slice(last);
}

function numberMethods() {
  return {
    toFixed: pure("toFixed", (interp, n, [d]) => n.toFixed(d === undefined ? 0 : toNumber(d))),
    toPrecision: pure("toPrecision", (interp, n, [d]) => (d === undefined ? String(n) : n.toPrecision(toNumber(d)))),
    toString: pure("toString", (interp, n, [radix]) => n.toString(radix === undefined ? 10 : toNumber(radix))),
    toLocaleString: pure("toLocaleString", (interp, n, [locale, opts]) => {
      const o = opts instanceof GObj ? JSON.parse(guestToJsonText(interp, opts)) : undefined;
      return n.toLocaleString(locale === undefined ? undefined : String(locale), o);
    }),
    valueOf: pure("valueOf", (interp, n) => n),
  };
}

function promiseMethods() {
  const then = (interp, p, onF, onR) => {
    const out = interp.newPromise();
    p.handled = true;
    interp.unhandled.delete(p);
    interp.onSettle(p, (state, value) => {
      interp.queueJob((function* () {
        const handler = state === "fulfilled" ? onF : onR;
        if (!isCallable(handler)) {
          if (state === "fulfilled") interp.resolve(out, value);
          else interp.reject(out, value);
          return;
        }
        try {
          interp.resolve(out, yield* interp.callFunction(handler, undefined, [value]));
        } catch (e) {
          if (e instanceof GuestThrow) interp.reject(out, e.value);
          else throw e;
        }
      })());
    });
    return out;
  };
  return {
    then: pure("then", (interp, p, [onF, onR]) => then(interp, p, onF, onR)),
    catch: pure("catch", (interp, p, [onR]) => then(interp, p, undefined, onR)),
    finally: pure("finally", (interp, p, [f]) => {
      const run = (rethrow) => new NFn("finally", function* (ip, self, [v]) {
        if (isCallable(f)) yield* ip.callFunction(f, undefined, []);
        if (rethrow) throw new GuestThrow(v);
        return v;
      });
      return then(interp, p, run(false), run(true));
    }),
  };
}

function functionMethods() {
  return {
    call: fn("call", function* (interp, self, [t, ...args]) {
      return yield* interp.callFunction(self, t, args);
    }),
    apply: fn("apply", function* (interp, self, [t, args]) {
      return yield* interp.callFunction(self, t, args === undefined || args === null ? [] : interp.iterate(args));
    }),
    bind: pure("bind", (interp, self, [t, ...args]) => new GBound(self, t, args)),
    toString: pure("toString", () => "function () { [code] }"),
  };
}

function objectMethods() {
  return {
    hasOwnProperty: pure("hasOwnProperty", (interp, self, [k]) => self.props.has(interp.toKey(k))),
    toString: pure("toString", (interp, self) => interp.toStr(self)),
  };
}

function mapMethods() {
  return {
    get: pure("get", (i, m, [k]) => m.map.get(k)),
    set: pure("set", (interp, m, [k, v]) => {
      if (!m.map.has(k)) interp.host.alloc(48);
      m.map.set(k, v);
      return m;
    }),
    has: pure("has", (i, m, [k]) => m.map.has(k)),
    delete: pure("delete", (i, m, [k]) => m.map.delete(k)),
    clear: pure("clear", (i, m) => m.map.clear()),
    keys: pure("keys", (i, m) => new GArr([...m.map.keys()])),
    values: pure("values", (i, m) => new GArr([...m.map.values()])),
    entries: pure("entries", (i, m) => new GArr([...m.map].map(([k, v]) => new GArr([k, v])))),
    forEach: fn("forEach", function* (interp, m, [f]) {
      callback(interp, f, "Map.prototype.forEach");
      for (const [k, v] of [...m.map]) yield* interp.callFunction(f, undefined, [v, k, m]);
    }),
  };
}

function setMethods() {
  return {
    add: pure("add", (interp, s, [v]) => {
      if (!s.set.has(v)) interp.host.alloc(32);
      s.set.add(v);
      return s;
    }),
    has: pure("has", (i, s, [v]) => s.set.has(v)),
    delete: pure("delete", (i, s, [v]) => s.set.delete(v)),
    clear: pure("clear", (i, s) => s.set.clear()),
    values: pure("values", (i, s) => new GArr([...s.set])),
    keys: pure("keys", (i, s) => new GArr([...s.set])),
    forEach: fn("forEach", function* (interp, s, [f]) {
      callback(interp, f, "Set.prototype.forEach");
      for (const v of [...s.set]) yield* interp.callFunction(f, undefined, [v, v, s]);
    }),
  };
}

function dateMethods() {
  const d = (name, f) => pure(name, (interp, self, args) => f(new Date(self.time), args, interp));
  const out = {
    getTime: pure("getTime", (i, self) => self.time),
    valueOf: pure("valueOf", (i, self) => self.time),
    toISOString: pure("toISOString", (interp, self) => {
      if (Number.isNaN(self.time)) interp.throwError("RangeError", "Invalid time value");
      return new Date(self.time).toISOString();
    }),
    toJSON: pure("toJSON", (i, self) => (Number.isNaN(self.time) ? null : new Date(self.time).toISOString())),
    toString: d("toString", (dt) => dt.toString()),
    toDateString: d("toDateString", (dt) => dt.toDateString()),
    toUTCString: d("toUTCString", (dt) => dt.toUTCString()),
    toLocaleDateString: d("toLocaleDateString", (dt, [l]) => dt.toLocaleDateString(l === undefined ? undefined : String(l))),
    toLocaleTimeString: d("toLocaleTimeString", (dt, [l]) => dt.toLocaleTimeString(l === undefined ? undefined : String(l))),
    toLocaleString: d("toLocaleString", (dt, [l]) => dt.toLocaleString(l === undefined ? undefined : String(l))),
  };
  for (const name of ["FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds", "Milliseconds"]) {
    out[`get${name}`] = d(`get${name}`, (dt) => dt[`get${name}`]());
    out[`getUTC${name}`] = d(`getUTC${name}`, (dt) => dt[`getUTC${name}`]());
  }
  out.getTimezoneOffset = d("getTimezoneOffset", (dt) => dt.getTimezoneOffset());
  return out;
}

function regexpMethods() {
  return {
    test: pure("test", (interp, self, [s]) => self.re.test(interp.toStr(s))),
    exec: pure("exec", (interp, self, [s]) => matchToGuest(self.re.exec(interp.toStr(s)))),
    toString: pure("toString", (interp, self) => String(self.re)),
  };
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

function errorConstructor(name, parent) {
  const make = (interp, [message]) => interp.makeError(name, message === undefined ? "" : interp.toStr(message));
  const ctor = fn(name, function* (interp, self, args) {
    return make(interp, args);
  }, {
    construct: function* (interp, args) {
      return make(interp, args);
    },
  });
  ctor.isInstance = (v) => v instanceof GError && (name === "Error" || v.name === name);
  ctor.parent = parent;
  return ctor;
}

function promiseStatics(Promise) {
  const all = (mode) => fn(mode, function* (interp, self, [iterable]) {
    const items = interp.iterate(iterable);
    const out = interp.newPromise();
    const results = new Array(items.length);
    let remaining = items.length;
    if (remaining === 0) {
      interp.resolve(out, mode === "any" ? undefined : new GArr([]));
      if (mode === "any") interp.reject(out, interp.makeError("AggregateError", "All promises were rejected"));
      return out;
    }
    items.forEach((item, i) => {
      const p = interp.toPromise(item);
      p.handled = true;
      interp.unhandled.delete(p);
      interp.onSettle(p, (state, value) => {
        if (mode === "race") return state === "fulfilled" ? interp.resolve(out, value) : interp.reject(out, value);
        if (mode === "all") {
          if (state === "rejected") return interp.reject(out, value);
          results[i] = value;
        } else if (mode === "allSettled") {
          const r = new GObj();
          r.props.set("status", state);
          r.props.set(state === "fulfilled" ? "value" : "reason", value);
          results[i] = r;
        } else if (mode === "any") {
          if (state === "fulfilled") return interp.resolve(out, value);
          results[i] = value;
        }
        if (--remaining === 0) {
          if (mode === "any") {
            const e = interp.makeError("AggregateError", "All promises were rejected");
            e.props.set("errors", new GArr(results));
            interp.reject(out, e);
          } else {
            interp.resolve(out, new GArr(results));
          }
        }
      });
    });
    return out;
  });
  return Promise.static({
    resolve: pure("resolve", (interp, self, [v]) => interp.toPromise(v)),
    reject: pure("reject", (interp, self, [v]) => {
      const p = interp.newPromise();
      interp.reject(p, v);
      return p;
    }),
    all: all("all"),
    allSettled: all("allSettled"),
    race: all("race"),
    any: all("any"),
  });
}

function makeDate(interp, args) {
  if (args.length === 0) return new GDate(Date.now());
  const [a] = args;
  if (args.length === 1) {
    if (a instanceof GDate) return new GDate(a.time);
    return new GDate(new Date(typeof a === "number" ? a : interp.toStr(a)).getTime());
  }
  return new GDate(new Date(...args.map(toNumber)).getTime());
}

// Method tables are looked up with guest-chosen keys, so they must have no
// prototype: otherwise `({}).constructor` would find the host's Object.
const table = (methods) => Object.freeze(Object.assign(Object.create(null), methods));

export function makeGlobals(interp, { extensions = {} } = {}) {
  interp.methods = table({
    array: table(arrayMethods()),
    string: table(stringMethods()),
    number: table(numberMethods()),
    boolean: table({ toString: pure("toString", (i, b) => String(b)) }),
    promise: table(promiseMethods()),
    function: table(functionMethods()),
    object: table(objectMethods()),
    map: table(mapMethods()),
    set: table(setMethods()),
    date: table(dateMethods()),
    regexp: table(regexpMethods()),
  });

  const Err = errorConstructor("Error");
  const errors = Object.fromEntries(
    ["TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError", "AggregateError"].map((n) => [n, errorConstructor(n, Err)]),
  );

  const Obj = fn("Object", function* (interp, self, [v]) {
    return v === undefined || v === null ? new GObj() : v;
  }).static({
    keys: pure("keys", (interp, self, [o]) => new GArr(interp.ownKeys(o))),
    values: pure("values", (interp, self, [o]) => new GArr(interp.ownKeys(o).map((k) => interp.getProp(o, k)))),
    entries: pure("entries", (interp, self, [o]) => new GArr(interp.ownKeys(o).map((k) => new GArr([k, interp.getProp(o, k)])))),
    assign: pure("assign", (interp, self, [target, ...sources]) => {
      for (const s of sources) for (const k of interp.ownKeys(s)) interp.setProp(target, k, interp.getProp(s, k));
      return target;
    }),
    fromEntries: pure("fromEntries", (interp, self, [entries]) => {
      const o = new GObj();
      for (const e of interp.iterate(entries)) {
        const [k, v] = interp.iterate(e);
        o.props.set(interp.toKey(k), v);
      }
      return o;
    }),
    freeze: pure("freeze", (interp, self, [o]) => {
      if (o instanceof GObj) o.frozen = true;
      return o;
    }),
    isFrozen: pure("isFrozen", (interp, self, [o]) => !(o instanceof GObj) || Boolean(o.frozen)),
    hasOwn: pure("hasOwn", (interp, self, [o, k]) => interp.ownKeys(o).includes(interp.toKey(k))),
    groupBy: fn("groupBy", function* (interp, self, [items, f]) {
      const out = new GObj();
      let i = 0;
      for (const item of interp.iterate(items)) {
        const key = interp.toKey(yield* interp.callFunction(f, undefined, [item, i++]));
        if (!out.props.has(key)) out.props.set(key, new GArr([]));
        out.props.get(key).items.push(item);
      }
      return out;
    }),
  });
  Obj.isInstance = (v) => v !== null && typeof v === "object";

  const Arr = fn("Array", function* (interp, self, args) {
    if (args.length === 1 && typeof args[0] === "number") {
      interp.checkArrayLength(args[0]);
      interp.host.alloc(args[0] * 8);
      return new GArr(new Array(args[0]).fill(undefined));
    }
    return new GArr(args);
  }, {
    construct: function* (interp, args) {
      if (args.length === 1 && typeof args[0] === "number") {
        interp.checkArrayLength(args[0]);
        interp.host.alloc(args[0] * 8);
        return new GArr(new Array(args[0]).fill(undefined));
      }
      return new GArr(args);
    },
  }).static({
    isArray: pure("isArray", (interp, self, [v]) => v instanceof GArr),
    of: pure("of", (interp, self, args) => new GArr(args)),
    from: fn("from", function* (interp, self, [src, mapFn]) {
      let items;
      if (src instanceof GObj && src.props.has("length") && !(src instanceof GArr)) {
        const n = toNumber(src.props.get("length"));
        interp.checkArrayLength(n);
        items = new Array(n).fill(undefined);
      } else {
        items = interp.iterate(src);
      }
      interp.host.alloc(items.length * 8);
      if (mapFn === undefined) return new GArr(items);
      const out = [];
      for (let i = 0; i < items.length; i++) out.push(yield* interp.callFunction(mapFn, undefined, [items[i], i]));
      return new GArr(out);
    }),
  });
  Arr.isInstance = (v) => v instanceof GArr;

  const Prom = promiseStatics(fn("Promise", function* (interp) {
    interp.typeError("Promise constructor cannot be invoked without 'new'");
  }, {
    construct: function* (interp, [executor]) {
      callback(interp, executor, "new Promise");
      const p = interp.newPromise();
      const resolveFn = pure("resolve", (ip, self, [v]) => ip.resolve(p, v));
      const rejectFn = pure("reject", (ip, self, [v]) => ip.reject(p, v));
      try {
        yield* interp.callFunction(executor, undefined, [resolveFn, rejectFn]);
      } catch (e) {
        if (e instanceof GuestThrow) interp.reject(p, e.value);
        else throw e;
      }
      return p;
    },
  }));
  Prom.isInstance = (v) => v instanceof GPromise;

  const MapCtor = fn("Map", function* (interp) {
    interp.typeError("Constructor Map requires 'new'");
  }, {
    construct: function* (interp, [entries]) {
      const m = new GMap();
      if (entries !== undefined && entries !== null) {
        for (const e of interp.iterate(entries)) {
          const [k, v] = interp.iterate(e);
          m.map.set(k, v);
        }
      }
      return m;
    },
  });
  MapCtor.isInstance = (v) => v instanceof GMap;

  const SetCtor = fn("Set", function* (interp) {
    interp.typeError("Constructor Set requires 'new'");
  }, {
    construct: function* (interp, [items]) {
      const s = new GSet();
      if (items !== undefined && items !== null) for (const v of interp.iterate(items)) s.set.add(v);
      return s;
    },
  });
  SetCtor.isInstance = (v) => v instanceof GSet;

  const DateCtor = fn("Date", function* () {
    return new Date().toString();
  }, {
    construct: function* (interp, args) {
      return makeDate(interp, args);
    },
  }).static({
    now: pure("now", () => Date.now()),
    parse: pure("parse", (interp, self, [s]) => Date.parse(interp.toStr(s))),
    UTC: pure("UTC", (interp, self, args) => Date.UTC(...args.map(toNumber))),
  });
  DateCtor.isInstance = (v) => v instanceof GDate;

  const RegExpCtor = fn("RegExp", function* (interp, self, [src, flags]) {
    return new GRegExp(src instanceof GRegExp ? src.re.source : interp.toStr(src), flags === undefined ? "" : interp.toStr(flags));
  }, {
    construct: function* (interp, [src, flags]) {
      try {
        return new GRegExp(src instanceof GRegExp ? src.re.source : interp.toStr(src), flags === undefined ? "" : interp.toStr(flags));
      } catch (e) {
        interp.throwError("SyntaxError", e.message);
      }
    },
  });
  RegExpCtor.isInstance = (v) => v instanceof GRegExp;

  const numberish = (name, f) => pure(name, (interp, self, args) => f(...args));
  const Num = fn("Number", function* (interp, self, [v]) {
    return v === undefined ? 0 : toNumber(interp.toPrimitive(v));
  }).static({
    isInteger: numberish("isInteger", Number.isInteger),
    isFinite: numberish("isFinite", Number.isFinite),
    isNaN: numberish("isNaN", Number.isNaN),
    isSafeInteger: numberish("isSafeInteger", Number.isSafeInteger),
    parseFloat: pure("parseFloat", (interp, self, [s]) => Number.parseFloat(interp.toStr(s))),
    parseInt: pure("parseInt", (interp, self, [s, r]) => Number.parseInt(interp.toStr(s), r)),
    MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
    MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
    MAX_VALUE: Number.MAX_VALUE,
    MIN_VALUE: Number.MIN_VALUE,
    EPSILON: Number.EPSILON,
    POSITIVE_INFINITY: Infinity,
    NEGATIVE_INFINITY: -Infinity,
    NaN: NaN,
  });

  const Str = fn("String", function* (interp, self, args) {
    return args.length === 0 ? "" : interp.toStr(args[0]);
  }).static({
    fromCharCode: pure("fromCharCode", (interp, self, args) => String.fromCharCode(...args.map(toNumber))),
    fromCodePoint: pure("fromCodePoint", (interp, self, args) => String.fromCodePoint(...args.map(toNumber))),
  });

  const mathFns = [
    "abs", "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "cbrt", "ceil", "clz32", "cos", "cosh", "exp",
    "expm1", "floor", "fround", "hypot", "imul", "log", "log10", "log1p", "log2", "max", "min", "pow", "random",
    "round", "sign", "sin", "sinh", "sqrt", "tan", "tanh", "trunc",
  ];
  const MathObj = new GObj();
  for (const name of mathFns) MathObj.props.set(name, pure(name, (interp, self, args) => Math[name](...args.map(toNumber))));
  for (const name of ["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2"]) MathObj.props.set(name, Math[name]);
  MathObj.frozen = true;

  const JSONObj = new GObj();
  JSONObj.props.set("stringify", pure("stringify", (interp, self, [v, replacer, space]) => {
    if (replacer !== undefined && replacer !== null) interp.typeError("JSON.stringify replacer is not supported");
    const indent = typeof space === "number" ? " ".repeat(Math.min(10, space)) : typeof space === "string" ? space.slice(0, 10) : "";
    const text = guestToJsonText(interp, v, indent);
    if (text !== undefined) interp.host.alloc(text.length * 2);
    return text;
  }));
  JSONObj.props.set("parse", pure("parse", (interp, self, [text, reviver]) => {
    if (reviver !== undefined) interp.typeError("JSON.parse reviver is not supported");
    let parsed;
    try {
      parsed = JSON.parse(interp.toStr(text));
    } catch (e) {
      interp.throwError("SyntaxError", e.message);
    }
    interp.host.alloc(interp.toStr(text).length * 4);
    return jsonToGuest(parsed);
  }));
  JSONObj.frozen = true;

  const consoleObj = new GObj();
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    consoleObj.props.set(level, pure(level, (interp, self, args) => {
      interp.host.log(level, args.map((a) => display(interp, a)).join(" "));
    }));
  }
  consoleObj.frozen = true;

  const uri = (name, f) => pure(name, (interp, self, [s]) => {
    try {
      return f(interp.toStr(s));
    } catch (e) {
      interp.throwError("URIError", e.message);
    }
  });

  const globals = {
    undefined: undefined,
    NaN: NaN,
    Infinity: Infinity,
    Object: Obj,
    Array: Arr,
    Promise: Prom,
    Map: MapCtor,
    Set: SetCtor,
    Date: DateCtor,
    RegExp: RegExpCtor,
    Number: Num,
    String: Str,
    Boolean: pure("Boolean", (interp, self, [v]) => truthy(v)),
    Math: MathObj,
    JSON: JSONObj,
    console: consoleObj,
    Error: Err,
    ...errors,
    parseInt: pure("parseInt", (interp, self, [s, r]) => Number.parseInt(interp.toStr(s), r)),
    parseFloat: pure("parseFloat", (interp, self, [s]) => Number.parseFloat(interp.toStr(s))),
    isNaN: pure("isNaN", (interp, self, [v]) => Number.isNaN(toNumber(v))),
    isFinite: pure("isFinite", (interp, self, [v]) => Number.isFinite(toNumber(v))),
    encodeURIComponent: uri("encodeURIComponent", encodeURIComponent),
    decodeURIComponent: uri("decodeURIComponent", decodeURIComponent),
    encodeURI: uri("encodeURI", encodeURI),
    decodeURI: uri("decodeURI", decodeURI),
    tools: new ToolRef([]),
    search: pure("search", (interp, self, [opts]) => interp.host.search(opts)),
    ...extensions,
  };
  return globals;
}

export { strictEquals, isIndex };
