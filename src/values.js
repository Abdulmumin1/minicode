// The guest value model.
//
// Guest primitives (number, string, boolean, null, undefined) are host
// primitives: they carry no capabilities. Everything else is an instance of
// one of the classes below. The interpreter decides what every property
// access means, so there is no prototype chain, no `constructor`, and no way
// to reach a host object from guest code.

export class GObj {
  constructor() {
    // A Map, not a host object: "__proto__" and "constructor" are just keys.
    this.props = new Map();
  }
}

export class GArr {
  constructor(items = []) {
    this.items = items;
  }
}

export class GError extends GObj {
  constructor(name, message) {
    super();
    this.props.set("name", name);
    this.props.set("message", message);
  }
  get name() {
    return this.props.get("name");
  }
  get message() {
    return this.props.get("message");
  }
}

// A guest closure: an acorn function node plus the environment it closed over.
export class GFn {
  constructor(node, env, { thisValue, name } = {}) {
    this.node = node;
    this.env = env;
    this.thisValue = thisValue; // only used by arrow functions
    this.name = name ?? node.id?.name ?? "";
  }
  get isArrow() {
    return this.node.type === "ArrowFunctionExpression";
  }
  get isAsync() {
    return this.node.async;
  }
}

// A built-in implemented by the interpreter. `impl` is a generator function
// `function* (interp, thisValue, args)` so built-ins that call back into
// guest code (map, filter, sort, then...) can be paused like everything else.
export class NFn {
  constructor(name, impl, { construct } = {}) {
    this.name = name;
    this.impl = impl;
    this.construct = construct; // generator used by `new`, if constructible
    this.props = null; // static members, e.g. Promise.all
  }
  static(members) {
    this.props = new Map(Object.entries(members));
    return this;
  }
}

// A bound function created by fn.bind(thisArg, ...args).
export class GBound {
  constructor(target, thisValue, args) {
    this.target = target;
    this.thisValue = thisValue;
    this.args = args;
  }
}

export class GPromise {
  constructor() {
    this.state = "pending";
    this.value = undefined;
    this.reactions = [];
    this.handled = false;
  }
}

// `tools`, `tools.math`, `tools.math.add`: a path, resolved when called.
export class ToolRef {
  constructor(path) {
    this.path = path;
  }
}

export class GMap {
  constructor() {
    this.map = new Map();
  }
}

export class GSet {
  constructor() {
    this.set = new Set();
  }
}

export class GDate {
  constructor(time) {
    this.time = time;
  }
}

export class GRegExp {
  constructor(source, flags) {
    this.re = new RegExp(source, flags);
  }
}

export const isCallable = (v) =>
  v instanceof GFn || v instanceof NFn || v instanceof GBound || (v instanceof ToolRef && v.path.length > 0);

export function typeOf(v) {
  if (v === null) return "object";
  const t = typeof v;
  if (t !== "object") return t;
  return isCallable(v) ? "function" : "object";
}

// ---- Control-flow signals (host-side, never visible to guest code) ----

// A guest `throw` (or a runtime error the guest can catch).
export class GuestThrow {
  constructor(value) {
    this.value = value;
  }
}

// Fatal: the run must stop and guest code may not catch it.
export class Halt extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// Yielded up through every generator when the fuel runs out, so the driver
// can check the clock, the memory, and give the host event loop a turn.
export const TICK = Symbol("tick");
