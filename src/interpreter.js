// A tree-walking interpreter for a safe subset of JavaScript.
//
// Every evaluation function is a generator. That lets the interpreter pause
// anywhere: at an `await` (yield { await: promise }), or when its fuel runs
// out (yield TICK) so the driver can check the clock and let the host breathe.

import { parse } from "acorn";
import {
  GArr, GBound, GDate, GError, GFn, GMap, GObj, GPromise, GRegExp, GSet, GuestThrow, Halt, NFn, TICK,
  ToolRef, isCallable, typeOf,
} from "./values.js";

export const FUEL = 10_000;
export const MAX_CALL_DEPTH = 500;
export const MAX_STRING_LENGTH = 1 << 24;
export const MAX_ARRAY_LENGTH = 10_000_000;
export const MAX_PENDING_PROMISES = 10_000;

// ---------------------------------------------------------------------------
// Parsing and the syntax allowlist
// ---------------------------------------------------------------------------

const SUPPORTED = new Set([
  "Program", "ExpressionStatement", "VariableDeclaration", "VariableDeclarator", "FunctionDeclaration",
  "FunctionExpression", "ArrowFunctionExpression", "ReturnStatement", "IfStatement", "ForStatement",
  "ForOfStatement", "ForInStatement", "WhileStatement", "DoWhileStatement", "BreakStatement",
  "ContinueStatement", "BlockStatement", "EmptyStatement", "ThrowStatement", "TryStatement", "CatchClause",
  "SwitchStatement", "SwitchCase", "LabeledStatement", "Identifier", "Literal", "TemplateLiteral",
  "TemplateElement", "ArrayExpression", "ObjectExpression", "Property", "SpreadElement", "RestElement",
  "ObjectPattern", "ArrayPattern", "AssignmentPattern", "UnaryExpression", "UpdateExpression",
  "BinaryExpression", "LogicalExpression", "AssignmentExpression", "ConditionalExpression", "CallExpression",
  "NewExpression", "MemberExpression", "ChainExpression", "AwaitExpression", "SequenceExpression",
  "ThisExpression",
]);

const HINT =
  "This runtime supports a safe subset of JavaScript: functions, arrow functions, async/await, objects, " +
  "arrays, destructuring, loops, try/catch and the usual built-ins. Classes, generators, getters/setters, " +
  "imports, BigInt and `with` are not supported. Use plain functions and data objects instead.";

export class SyntaxProblem extends Error {
  constructor(kind, message, loc) {
    super(message);
    this.kind = kind;
    this.line = loc?.line;
    this.column = loc?.column;
  }
}

export function parseProgram(code) {
  if (!code.trim()) throw new SyntaxProblem("ParseError", "The program is empty.");
  let ast;
  try {
    ast = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      locations: true,
    });
  } catch (e) {
    throw new SyntaxProblem("ParseError", e.message, e.loc);
  }
  validate(ast);
  annotate(ast);
  return ast;
}

// One pass over the tree to precompute two facts per node:
//  - pure: the expression contains no call, `new` or `await`, so it cannot run
//    guest code, pause, or loop. It can be evaluated synchronously, without
//    allocating generators. (Guest code never runs implicitly here: there are
//    no getters, no valueOf, no toString overrides.)
//  - closures: the subtree creates a function, so `for (let ...)` must give
//    each iteration its own copy of the loop variable.
const IMPURE = new Set(["CallExpression", "NewExpression", "AwaitExpression"]);
const FUNCTIONS = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);

function annotate(node) {
  if (!node || typeof node !== "object") return { pure: true, closures: false };
  if (Array.isArray(node)) {
    let pure = true;
    let closures = false;
    for (const n of node) {
      const r = annotate(n);
      pure &&= r.pure;
      closures ||= r.closures;
    }
    return { pure, closures };
  }
  if (typeof node.type !== "string") return { pure: true, closures: false };
  let pure = !IMPURE.has(node.type);
  let closures = FUNCTIONS.has(node.type);
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const child = node[key];
    if (!child || typeof child !== "object") continue;
    const r = annotate(child);
    // A function's body doesn't run when the function is created.
    if (!FUNCTIONS.has(node.type)) pure &&= r.pure;
    closures ||= r.closures;
  }
  // Destructuring assignment goes through the generator path.
  if (node.type === "AssignmentExpression" && node.left.type !== "Identifier" && node.left.type !== "MemberExpression") pure = false;
  if (node.type === "Literal" && node.regex) pure = true;
  node.pure = pure;
  node.closures = closures;
  // simple: a statement that can run synchronously (see stmtSync).
  switch (node.type) {
    case "ExpressionStatement": node.simple = node.expression.pure; break;
    case "EmptyStatement": node.simple = true; break;
    case "BlockStatement": node.simple = node.body.every((s) => s.simple); break;
    case "IfStatement": node.simple = node.test.pure && node.consequent.simple && (!node.alternate || node.alternate.simple); break;
  }
  return { pure, closures };
}

// Walk the whole tree before running anything. A program with unsupported
// syntax fails up front, before any tool has been called.
function validate(node) {
  if (Array.isArray(node)) return node.forEach(validate);
  if (!node || typeof node.type !== "string") return;
  const bad = (what) => {
    throw new SyntaxProblem("UnsupportedSyntax", `${what} is not supported. ${HINT}`, node.loc?.start);
  };
  if (!SUPPORTED.has(node.type)) bad(`Syntax '${node.type}'`);
  if (node.generator) bad("Generator functions");
  if (node.type === "Property" && node.kind !== "init") bad("Getters and setters");
  if (node.type === "Literal" && typeof node.value === "bigint") bad("BigInt");
  if (node.type === "ForOfStatement" && node.await) bad("for await");
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "type") continue;
    const child = node[key];
    if (child && typeof child === "object") validate(child);
  }
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

class Env {
  constructor(parent, isFunction = false) {
    this.vars = new Map();
    this.parent = parent;
    this.isFunction = isFunction;
  }
  declare(name, kind, value, init = true) {
    this.vars.set(name, { value, kind, init });
  }
  lookup(name) {
    for (let env = this; env; env = env.parent) {
      const b = env.vars.get(name);
      if (b) return b;
    }
    return undefined;
  }
  functionScope() {
    let env = this;
    while (!env.isFunction && env.parent) env = env.parent;
    return env;
  }
}

// Collect `var` names in a function body without entering nested functions.
function collectVars(node, out) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) collectVars(n, out);
    return out;
  }
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
    return out;
  }
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const d of node.declarations) patternNames(d.id, out);
  }
  for (const key of Object.keys(node)) {
    if (key !== "loc" && node[key] && typeof node[key] === "object") collectVars(node[key], out);
  }
  return out;
}

function patternNames(p, out) {
  switch (p.type) {
    case "Identifier": out.push(p.name); break;
    case "ObjectPattern": for (const prop of p.properties) patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out); break;
    case "ArrayPattern": for (const el of p.elements) if (el) patternNames(el, out); break;
    case "AssignmentPattern": patternNames(p.left, out); break;
    case "RestElement": patternNames(p.argument, out); break;
  }
  return out;
}

// Completions for statements.
const BREAK = (label) => ({ type: "break", label });
const CONTINUE = (label) => ({ type: "continue", label });
const RETURN = (value) => ({ type: "return", value });

// Thrown to short-circuit an optional chain like a?.b.c
const SHORT_CIRCUIT = Symbol("short-circuit");

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

export class Interpreter {
  constructor({ host, globals }) {
    this.host = host; // { callTool(path, args) => GPromise, alloc(bytes) }
    this.fuel = FUEL;
    this.steps = 0;
    this.depth = 0;
    this.jobs = []; // queued generators (microtasks)
    this.pendingPromises = 0;
    this.unhandled = new Set();
    this.root = new Env(null, true);
    for (const [name, value] of Object.entries(globals(this))) this.root.declare(name, "builtin", value);
  }

  // ---- errors --------------------------------------------------------------

  makeError(name, message) {
    const e = new GError(name, message);
    e.at = this.at; // where the current statement starts (host-side only)
    return e;
  }
  throwError(name, message) {
    throw new GuestThrow(this.makeError(name, message));
  }
  typeError(message) {
    this.throwError("TypeError", message);
  }

  checkString(s) {
    if (s.length > MAX_STRING_LENGTH) this.throwError("RangeError", "Invalid string length");
    return s;
  }
  checkArrayLength(n) {
    if (n > MAX_ARRAY_LENGTH) this.throwError("RangeError", "Invalid array length");
  }

  // ---- running the program ---------------------------------------------------

  // The program body runs as the body of an implicit async function. With no
  // `return`, a final expression statement becomes the result.
  *programBody(ast) {
    const env = new Env(this.root, true);
    env.declare("%this", "const", undefined);
    this.hoist(ast.body, env, env);
    const body = ast.body;
    for (let i = 0; i < body.length; i++) {
      const node = body[i];
      if (i === body.length - 1 && node.type === "ExpressionStatement") {
        this.at = node.loc?.start;
        return (node.expression.pure ? this.sx(node.expression, env) : yield* this.expr(node.expression, env));
      }
      const c = (node.simple ? this.stmtSync(node, env) : yield* this.stmt(node, env));
      if (c?.type === "return") return c.value;
      if (c) this.throwError("SyntaxError", `Illegal ${c.type} statement`);
    }
    return undefined;
  }

  hoist(stmts, blockEnv, fnEnv) {
    if (fnEnv === blockEnv) {
      for (const name of collectVars(stmts, [])) if (!fnEnv.vars.has(name)) fnEnv.declare(name, "var", undefined);
    }
    for (const s of stmts) {
      if (s.type === "VariableDeclaration" && s.kind !== "var") {
        for (const d of s.declarations) for (const name of patternNames(d.id, [])) blockEnv.declare(name, s.kind, undefined, false);
      } else if (s.type === "FunctionDeclaration") {
        blockEnv.declare(s.id.name, "let", new GFn(s, blockEnv));
      }
    }
  }

  // ---- statements -------------------------------------------------------------

  *block(stmts, env) {
    for (const s of stmts) {
      const c = (s.simple ? this.stmtSync(s, env) : yield* this.stmt(s, env));
      if (c) return c;
    }
    return undefined;
  }

  // Run a "simple" statement synchronously: only pure expressions, blocks with
  // no declarations, and ifs. It can't break, return, call or loop, so it can't
  // run long; the enclosing loop still spends fuel and yields.
  stmtSync(node, env) {
    this.steps++;
    this.fuel--;
    this.at = node.loc?.start;
    switch (node.type) {
      case "ExpressionStatement":
        this.sx(node.expression, env);
        return;
      case "BlockStatement":
        for (const s of node.body) this.stmtSync(s, env);
        return;
      case "IfStatement":
        if (truthy(this.sx(node.test, env))) this.stmtSync(node.consequent, env);
        else if (node.alternate) this.stmtSync(node.alternate, env);
        return;
    }
  }

  *stmt(node, env, labels) {
    if (node.simple) return this.stmtSync(node, env);
    if (--this.fuel <= 0) yield TICK;
    this.steps++;
    this.at = node.loc?.start;
    switch (node.type) {
      case "ExpressionStatement":
        (node.expression.pure ? this.sx(node.expression, env) : yield* this.expr(node.expression, env));
        return;
      case "VariableDeclaration":
        for (const d of node.declarations) {
          let value;
          if (d.init) value = yield* this.namedExpr(d.init, env, d.id.type === "Identifier" ? d.id.name : undefined);
          else if (node.kind !== "var") value = undefined;
          else continue; // `var x;` keeps the hoisted value
          yield* this.bindPattern(d.id, value, env, node.kind);
        }
        return;
      case "FunctionDeclaration":
      case "EmptyStatement":
        return;
      case "ReturnStatement":
        return RETURN(node.argument ? (node.argument.pure ? this.sx(node.argument, env) : yield* this.expr(node.argument, env)) : undefined);
      case "IfStatement":
        if (truthy((node.test.pure ? this.sx(node.test, env) : yield* this.expr(node.test, env)))) return (node.consequent.simple ? this.stmtSync(node.consequent, env) : yield* this.stmt(node.consequent, env));
        if (node.alternate) return (node.alternate.simple ? this.stmtSync(node.alternate, env) : yield* this.stmt(node.alternate, env));
        return;
      case "BlockStatement": {
        const inner = new Env(env);
        this.hoist(node.body, inner, env.functionScope());
        return yield* this.block(node.body, inner);
      }
      case "ThrowStatement":
        throw new GuestThrow((node.argument.pure ? this.sx(node.argument, env) : yield* this.expr(node.argument, env)));
      case "TryStatement":
        return yield* this.tryStmt(node, env);
      case "BreakStatement":
        return BREAK(node.label?.name);
      case "ContinueStatement":
        return CONTINUE(node.label?.name);
      case "LabeledStatement": {
        const set = new Set(labels ?? []);
        set.add(node.label.name);
        const c = yield* this.stmt(node.body, env, set);
        if (c?.type === "break" && c.label === node.label.name) return;
        return c;
      }
      case "WhileStatement":
      case "DoWhileStatement":
        return yield* this.whileLoop(node, env, labels);
      case "ForStatement":
        return yield* this.forLoop(node, env, labels);
      case "ForOfStatement":
      case "ForInStatement":
        return yield* this.forEachLoop(node, env, labels);
      case "SwitchStatement":
        return yield* this.switchStmt(node, env);
      default:
        this.throwError("SyntaxError", `Unsupported statement ${node.type}`);
    }
  }

  // Decide what a loop does with a completion from its body.
  // Returns "next", "exit", or a completion to propagate.
  loopControl(c, labels) {
    if (!c) return "next";
    if (c.type === "break" && (!c.label || labels?.has(c.label))) return "exit";
    if (c.type === "continue" && (!c.label || labels?.has(c.label))) return "next";
    return c;
  }

  *whileLoop(node, env, labels) {
    let first = node.type === "DoWhileStatement";
    while (first || truthy((node.test.pure ? this.sx(node.test, env) : yield* this.expr(node.test, env)))) {
      first = false;
      if (--this.fuel <= 0) yield TICK;
      const r = this.loopControl((node.body.simple ? this.stmtSync(node.body, env) : yield* this.stmt(node.body, env)), labels);
      if (r === "exit") return;
      if (r !== "next") return r;
    }
  }

  *forLoop(node, env, labels) {
    let loopEnv = new Env(env);
    const perIteration = node.init?.type === "VariableDeclaration" && node.init.kind !== "var" && node.closures;
    if (node.init) {
      if (node.init.type === "VariableDeclaration") {
        this.hoist([node.init], loopEnv, env.functionScope());
        (node.init.simple ? this.stmtSync(node.init, loopEnv) : yield* this.stmt(node.init, loopEnv));
      } else {
        (node.init.pure ? this.sx(node.init, loopEnv) : yield* this.expr(node.init, loopEnv));
      }
    }
    while (true) {
      if (node.test && !truthy((node.test.pure ? this.sx(node.test, loopEnv) : yield* this.expr(node.test, loopEnv)))) return;
      if (--this.fuel <= 0) yield TICK;
      const r = this.loopControl((node.body.simple ? this.stmtSync(node.body, loopEnv) : yield* this.stmt(node.body, loopEnv)), labels);
      if (r === "exit") return;
      if (r !== "next") return r;
      // `let` bindings get a fresh copy per iteration, so closures capture each value.
      if (perIteration) {
        const next = new Env(env);
        for (const [k, b] of loopEnv.vars) next.vars.set(k, { ...b });
        loopEnv = next;
      }
      if (node.update) (node.update.pure ? this.sx(node.update, loopEnv) : yield* this.expr(node.update, loopEnv));
    }
  }

  *forEachLoop(node, env, labels) {
    const subject = (node.right.pure ? this.sx(node.right, env) : yield* this.expr(node.right, env));
    let items;
    if (node.type === "ForInStatement") {
      items = this.ownKeys(subject);
    } else if (subject instanceof GArr) {
      items = null; // iterate live, so pushes during the loop are seen
    } else {
      items = this.iterate(subject);
    }
    const decl = node.left.type === "VariableDeclaration" ? node.left : null;
    const target = decl ? decl.declarations[0].id : node.left;
    for (let i = 0; items ? i < items.length : i < subject.items.length; i++) {
      if (--this.fuel <= 0) yield TICK;
      const value = items ? items[i] : subject.items[i];
      const iterEnv = new Env(env);
      if (decl) {
        if (decl.kind !== "var") for (const n of patternNames(target, [])) iterEnv.declare(n, decl.kind, undefined, false);
        yield* this.bindPattern(target, value, iterEnv, decl.kind);
      } else {
        yield* this.bindPattern(target, value, iterEnv, "assign");
      }
      const r = this.loopControl((node.body.simple ? this.stmtSync(node.body, iterEnv) : yield* this.stmt(node.body, iterEnv)), labels);
      if (r === "exit") return;
      if (r !== "next") return r;
    }
  }

  *switchStmt(node, env) {
    const value = (node.discriminant.pure ? this.sx(node.discriminant, env) : yield* this.expr(node.discriminant, env));
    const inner = new Env(env);
    for (const c of node.cases) this.hoist(c.consequent, inner, env.functionScope());
    let matched = -1;
    for (let i = 0; i < node.cases.length; i++) {
      const test = node.cases[i].test;
      if (test && strictEquals(value, (test.pure ? this.sx(test, inner) : yield* this.expr(test, inner)))) {
        matched = i;
        break;
      }
    }
    if (matched < 0) matched = node.cases.findIndex((c) => !c.test);
    if (matched < 0) return;
    for (let i = matched; i < node.cases.length; i++) {
      const c = yield* this.block(node.cases[i].consequent, inner);
      if (c?.type === "break" && !c.label) return;
      if (c) return c;
    }
  }

  *tryStmt(node, env) {
    let completion;
    let pending; // a GuestThrow to rethrow after finally
    try {
      completion = (node.block.simple ? this.stmtSync(node.block, env) : yield* this.stmt(node.block, env));
    } catch (e) {
      if (!(e instanceof GuestThrow) || !node.handler) {
        if (!node.finalizer) throw e;
        pending = e;
      } else {
        const catchEnv = new Env(env);
        if (node.handler.param) {
          for (const n of patternNames(node.handler.param, [])) catchEnv.declare(n, "let", undefined, false);
          yield* this.bindPattern(node.handler.param, e.value, catchEnv, "let");
        }
        try {
          completion = (node.handler.body.simple ? this.stmtSync(node.handler.body, catchEnv) : yield* this.stmt(node.handler.body, catchEnv));
        } catch (e2) {
          if (!node.finalizer) throw e2;
          pending = e2;
        }
      }
    }
    if (node.finalizer) {
      // Halt is fatal: never run guest code once the run is being stopped.
      if (pending instanceof Halt) throw pending;
      const f = (node.finalizer.simple ? this.stmtSync(node.finalizer, env) : yield* this.stmt(node.finalizer, env));
      if (f) return f;
    }
    if (pending) throw pending;
    return completion;
  }

  // ---- expressions ------------------------------------------------------------

  // Evaluate, and give anonymous functions the name they are assigned to.
  *namedExpr(node, env, name) {
    const v = (node.pure ? this.sx(node, env) : yield* this.expr(node, env));
    if (name && v instanceof GFn && !v.name) v.name = name;
    return v;
  }

  *expr(node, env) {
    if (node.pure) return this.sx(node, env);
    switch (node.type) {
      case "Literal":
        if (node.regex) return new GRegExp(node.regex.pattern, node.regex.flags);
        return node.value;
      case "Identifier":
        return this.readVar(node.name, env);
      case "ThisExpression":
        return env.lookup("%this")?.value;
      case "TemplateLiteral": {
        let s = node.quasis[0].value.cooked;
        for (let i = 0; i < node.expressions.length; i++) {
          s += this.toStr((node.expressions[i].pure ? this.sx(node.expressions[i], env) : yield* this.expr(node.expressions[i], env))) + node.quasis[i + 1].value.cooked;
          this.checkString(s);
        }
        this.host.alloc(s.length * 2);
        return s;
      }
      case "ArrayExpression": {
        const items = [];
        for (const el of node.elements) {
          if (el === null) items.push(undefined);
          else if (el.type === "SpreadElement") for (const v of this.iterate((el.argument.pure ? this.sx(el.argument, env) : yield* this.expr(el.argument, env)))) items.push(v);
          else items.push((el.pure ? this.sx(el, env) : yield* this.expr(el, env)));
        }
        this.checkArrayLength(items.length);
        this.host.alloc(16 + items.length * 8);
        return new GArr(items);
      }
      case "ObjectExpression": {
        const obj = new GObj();
        for (const p of node.properties) {
          if (p.type === "SpreadElement") {
            const src = (p.argument.pure ? this.sx(p.argument, env) : yield* this.expr(p.argument, env));
            for (const k of this.ownKeys(src)) obj.props.set(k, this.getProp(src, k));
            continue;
          }
          const key = p.computed ? this.toKey((p.key.pure ? this.sx(p.key, env) : yield* this.expr(p.key, env))) : p.key.type === "Identifier" ? p.key.name : String(p.key.value);
          obj.props.set(key, yield* this.namedExpr(p.value, env, key));
        }
        this.host.alloc(48 + obj.props.size * 32);
        return obj;
      }
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return new GFn(node, env);
      case "UnaryExpression":
        return yield* this.unary(node, env);
      case "UpdateExpression": {
        const old = toNumber((node.argument.pure ? this.sx(node.argument, env) : yield* this.expr(node.argument, env)));
        const next = node.operator === "++" ? old + 1 : old - 1;
        yield* this.assignTo(node.argument, next, env);
        return node.prefix ? next : old;
      }
      case "BinaryExpression":
        return this.binary(node.operator, (node.left.pure ? this.sx(node.left, env) : yield* this.expr(node.left, env)), (node.right.pure ? this.sx(node.right, env) : yield* this.expr(node.right, env)));
      case "LogicalExpression": {
        const left = (node.left.pure ? this.sx(node.left, env) : yield* this.expr(node.left, env));
        if (node.operator === "&&") return truthy(left) ? (node.right.pure ? this.sx(node.right, env) : yield* this.expr(node.right, env)) : left;
        if (node.operator === "||") return truthy(left) ? left : (node.right.pure ? this.sx(node.right, env) : yield* this.expr(node.right, env));
        return left ?? ((node.right.pure ? this.sx(node.right, env) : yield* this.expr(node.right, env)));
      }
      case "ConditionalExpression":
        return truthy((node.test.pure ? this.sx(node.test, env) : yield* this.expr(node.test, env))) ? (node.consequent.pure ? this.sx(node.consequent, env) : yield* this.expr(node.consequent, env)) : (node.alternate.pure ? this.sx(node.alternate, env) : yield* this.expr(node.alternate, env));
      case "AssignmentExpression":
        return yield* this.assignment(node, env);
      case "SequenceExpression": {
        let v;
        for (const e of node.expressions) v = (e.pure ? this.sx(e, env) : yield* this.expr(e, env));
        return v;
      }
      case "MemberExpression": {
        const obj = (node.object.pure ? this.sx(node.object, env) : yield* this.expr(node.object, env));
        if (node.optional && (obj === null || obj === undefined)) throw SHORT_CIRCUIT;
        return this.getProp(obj, yield* this.memberKey(node, env));
      }
      case "ChainExpression":
        try {
          return (node.expression.pure ? this.sx(node.expression, env) : yield* this.expr(node.expression, env));
        } catch (e) {
          if (e === SHORT_CIRCUIT) return undefined;
          throw e;
        }
      case "CallExpression":
        return yield* this.call(node, env);
      case "NewExpression":
        return yield* this.construct(node, env);
      case "AwaitExpression": {
        const p = this.toPromise((node.argument.pure ? this.sx(node.argument, env) : yield* this.expr(node.argument, env)));
        p.handled = true;
        this.unhandled.delete(p);
        // The task runner turns this into a resume or a throw.
        return yield { await: p };
      }
      default:
        this.throwError("SyntaxError", `Unsupported expression ${node.type}`);
    }
  }

  // The synchronous evaluator for pure expressions (see annotate). Same
  // semantics as expr(), minus everything that could call, pause or await.
  sx(node, env) {
    switch (node.type) {
      case "Literal":
        if (node.regex) return new GRegExp(node.regex.pattern, node.regex.flags);
        return node.value;
      case "Identifier": {
        const b = env.lookup(node.name);
        if (b?.init) return b.value;
        return this.readVar(node.name, env); // throws the right error
      }
      case "ThisExpression":
        return env.lookup("%this")?.value;
      case "BinaryExpression":
        return this.binary(node.operator, this.sx(node.left, env), this.sx(node.right, env));
      case "LogicalExpression": {
        const left = this.sx(node.left, env);
        if (node.operator === "&&") return truthy(left) ? this.sx(node.right, env) : left;
        if (node.operator === "||") return truthy(left) ? left : this.sx(node.right, env);
        return left ?? this.sx(node.right, env);
      }
      case "ConditionalExpression":
        return truthy(this.sx(node.test, env)) ? this.sx(node.consequent, env) : this.sx(node.alternate, env);
      case "MemberExpression": {
        const obj = this.sx(node.object, env);
        if (node.optional && (obj === null || obj === undefined)) throw SHORT_CIRCUIT;
        return this.getProp(obj, node.computed ? this.toKey(this.sx(node.property, env)) : node.property.name);
      }
      case "ChainExpression":
        try {
          return this.sx(node.expression, env);
        } catch (e) {
          if (e === SHORT_CIRCUIT) return undefined;
          throw e;
        }
      case "UpdateExpression": {
        const old = toNumber(this.sx(node.argument, env));
        const next = node.operator === "++" ? old + 1 : old - 1;
        this.assignSync(node.argument, next, env);
        return node.prefix ? next : old;
      }
      case "AssignmentExpression": {
        const op = node.operator;
        if (op === "=") {
          const v = this.sx(node.right, env);
          if (node.left.type === "Identifier" && v instanceof GFn && !v.name) v.name = node.left.name;
          this.assignSync(node.left, v, env);
          return v;
        }
        const current = this.sx(node.left, env);
        if (op === "&&=" || op === "||=" || op === "??=") {
          const keep = op === "&&=" ? !truthy(current) : op === "||=" ? truthy(current) : current !== null && current !== undefined;
          if (keep) return current;
          const v = this.sx(node.right, env);
          this.assignSync(node.left, v, env);
          return v;
        }
        const v = this.binary(op.slice(0, -1), current, this.sx(node.right, env));
        this.assignSync(node.left, v, env);
        return v;
      }
      case "UnaryExpression": {
        if (node.operator === "typeof" && node.argument.type === "Identifier") {
          const b = env.lookup(node.argument.name);
          return b ? typeOf(b.value) : "undefined";
        }
        if (node.operator === "delete") {
          if (node.argument.type !== "MemberExpression") return true;
          const obj = this.sx(node.argument.object, env);
          const key = node.argument.computed ? this.toKey(this.sx(node.argument.property, env)) : node.argument.property.name;
          if (obj instanceof GObj) obj.props.delete(key);
          else if (obj instanceof GArr && isIndex(key)) obj.items[Number(key)] = undefined;
          return true;
        }
        const v = this.sx(node.argument, env);
        switch (node.operator) {
          case "!": return !truthy(v);
          case "-": return -toNumber(this.toPrimitive(v));
          case "+": return toNumber(this.toPrimitive(v));
          case "~": return ~toNumber(v);
          case "typeof": return typeOf(v);
          case "void": return undefined;
        }
        break;
      }
      case "TemplateLiteral": {
        let s = node.quasis[0].value.cooked;
        for (let i = 0; i < node.expressions.length; i++) {
          s += this.toStr(this.sx(node.expressions[i], env)) + node.quasis[i + 1].value.cooked;
          this.checkString(s);
        }
        this.host.alloc(s.length * 2);
        return s;
      }
      case "ArrayExpression": {
        const items = [];
        for (const el of node.elements) {
          if (el === null) items.push(undefined);
          else if (el.type === "SpreadElement") for (const v of this.iterate(this.sx(el.argument, env))) items.push(v);
          else items.push(this.sx(el, env));
        }
        this.checkArrayLength(items.length);
        this.host.alloc(16 + items.length * 8);
        return new GArr(items);
      }
      case "ObjectExpression": {
        const obj = new GObj();
        for (const p of node.properties) {
          if (p.type === "SpreadElement") {
            const src = this.sx(p.argument, env);
            for (const k of this.ownKeys(src)) obj.props.set(k, this.getProp(src, k));
            continue;
          }
          const key = p.computed ? this.toKey(this.sx(p.key, env)) : p.key.type === "Identifier" ? p.key.name : String(p.key.value);
          const v = this.sx(p.value, env);
          if (v instanceof GFn && !v.name) v.name = key;
          obj.props.set(key, v);
        }
        this.host.alloc(48 + obj.props.size * 32);
        return obj;
      }
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return new GFn(node, env);
      case "SequenceExpression": {
        let v;
        for (const e of node.expressions) v = this.sx(e, env);
        return v;
      }
    }
    this.throwError("SyntaxError", `Unsupported expression ${node.type}`);
  }

  assignSync(target, value, env) {
    if (target.type === "Identifier") {
      const b = env.lookup(target.name);
      if (!b) this.throwError("ReferenceError", `${target.name} is not defined`);
      if (!b.init) this.throwError("ReferenceError", `Cannot access '${target.name}' before initialization`);
      if (b.kind === "const") this.typeError("Assignment to constant variable.");
      if (b.kind === "builtin") this.typeError(`${target.name} is a built-in and cannot be reassigned. Declare your own variable instead.`);
      b.value = value;
      return;
    }
    const obj = this.sx(target.object, env);
    const key = target.computed ? this.toKey(this.sx(target.property, env)) : target.property.name;
    this.setProp(obj, key, value);
  }

  *memberKey(node, env) {
    if (!node.computed) return node.property.name;
    return this.toKey((node.property.pure ? this.sx(node.property, env) : yield* this.expr(node.property, env)));
  }

  readVar(name, env) {
    const b = env.lookup(name);
    if (!b) this.throwError("ReferenceError", `${name} is not defined`);
    if (!b.init) this.throwError("ReferenceError", `Cannot access '${name}' before initialization`);
    return b.value;
  }

  *unary(node, env) {
    if (node.operator === "typeof" && node.argument.type === "Identifier") {
      const b = env.lookup(node.argument.name);
      return b ? typeOf(b.value) : "undefined";
    }
    if (node.operator === "delete") {
      if (node.argument.type !== "MemberExpression") return true;
      const obj = (node.argument.object.pure ? this.sx(node.argument.object, env) : yield* this.expr(node.argument.object, env));
      const key = yield* this.memberKey(node.argument, env);
      if (obj instanceof GObj) obj.props.delete(key);
      else if (obj instanceof GArr && isIndex(key)) obj.items[Number(key)] = undefined;
      return true;
    }
    const v = (node.argument.pure ? this.sx(node.argument, env) : yield* this.expr(node.argument, env));
    switch (node.operator) {
      case "!": return !truthy(v);
      case "-": return -toNumber(this.toPrimitive(v));
      case "+": return toNumber(this.toPrimitive(v));
      case "~": return ~toNumber(v);
      case "typeof": return typeOf(v);
      case "void": return undefined;
    }
  }

  binary(op, a, b) {
    switch (op) {
      case "+": {
        const pa = this.toPrimitive(a);
        const pb = this.toPrimitive(b);
        if (typeof pa === "string" || typeof pb === "string") {
          const s = this.checkString(this.toStr(pa) + this.toStr(pb));
          this.host.alloc(s.length * 2);
          return s;
        }
        return toNumber(pa) + toNumber(pb);
      }
      case "-": return toNumber(this.toPrimitive(a)) - toNumber(this.toPrimitive(b));
      case "*": return toNumber(a) * toNumber(b);
      case "/": return toNumber(a) / toNumber(b);
      case "%": return toNumber(a) % toNumber(b);
      case "**": return toNumber(a) ** toNumber(b);
      case "===": return strictEquals(a, b);
      case "!==": return !strictEquals(a, b);
      case "==": return this.looseEquals(a, b);
      case "!=": return !this.looseEquals(a, b);
      case "<": return this.compare(a, b, (x, y) => x < y);
      case ">": return this.compare(a, b, (x, y) => x > y);
      case "<=": return this.compare(a, b, (x, y) => x <= y);
      case ">=": return this.compare(a, b, (x, y) => x >= y);
      case "&": return toNumber(a) & toNumber(b);
      case "|": return toNumber(a) | toNumber(b);
      case "^": return toNumber(a) ^ toNumber(b);
      case "<<": return toNumber(a) << toNumber(b);
      case ">>": return toNumber(a) >> toNumber(b);
      case ">>>": return toNumber(a) >>> toNumber(b);
      case "in": {
        const key = this.toKey(a);
        if (b instanceof GObj) return b.props.has(key);
        if (b instanceof GArr) return key === "length" || (isIndex(key) && Number(key) < b.items.length);
        if (b instanceof GMap || b instanceof GSet) return false;
        this.typeError(`Cannot use 'in' operator to search for '${key}' in ${this.toStr(b)}`);
        break;
      }
      case "instanceof":
        if (!(b instanceof NFn) || !b.isInstance) this.typeError("Right-hand side of 'instanceof' is not callable");
        return b.isInstance(a);
    }
    this.throwError("SyntaxError", `Unsupported operator ${op}`);
  }

  compare(a, b, f) {
    const pa = this.toPrimitive(a);
    const pb = this.toPrimitive(b);
    if (typeof pa === "string" && typeof pb === "string") return f(pa, pb);
    return f(toNumber(pa), toNumber(pb));
  }

  looseEquals(a, b) {
    if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
    if (a === null || a === undefined || b === null || b === undefined) return false;
    const ta = typeof a;
    const tb = typeof b;
    if (ta === tb || (ta === "object" && tb === "object")) return strictEquals(a, b);
    const pa = this.toPrimitive(a);
    const pb = this.toPrimitive(b);
    if (typeof pa === "string" && typeof pb === "string") return pa === pb;
    return toNumber(pa) === toNumber(pb);
  }

  *assignment(node, env) {
    const op = node.operator;
    if (op === "=") {
      const name = node.left.type === "Identifier" ? node.left.name : undefined;
      const v = yield* this.namedExpr(node.right, env, name);
      if (node.left.type === "ObjectPattern" || node.left.type === "ArrayPattern") {
        yield* this.bindPattern(node.left, v, env, "assign");
      } else {
        yield* this.assignTo(node.left, v, env);
      }
      return v;
    }
    const current = (node.left.pure ? this.sx(node.left, env) : yield* this.expr(node.left, env));
    if (op === "&&=" || op === "||=" || op === "??=") {
      const keep = op === "&&=" ? !truthy(current) : op === "||=" ? truthy(current) : current !== null && current !== undefined;
      if (keep) return current;
      const v = (node.right.pure ? this.sx(node.right, env) : yield* this.expr(node.right, env));
      yield* this.assignTo(node.left, v, env);
      return v;
    }
    const v = this.binary(op.slice(0, -1), current, (node.right.pure ? this.sx(node.right, env) : yield* this.expr(node.right, env)));
    yield* this.assignTo(node.left, v, env);
    return v;
  }

  *assignTo(target, value, env) {
    if (target.type === "Identifier") {
      const b = env.lookup(target.name);
      if (!b) this.throwError("ReferenceError", `${target.name} is not defined`);
      if (!b.init) this.throwError("ReferenceError", `Cannot access '${target.name}' before initialization`);
      if (b.kind === "const") this.typeError("Assignment to constant variable.");
      if (b.kind === "builtin") this.typeError(`${target.name} is a built-in and cannot be reassigned. Declare your own variable instead.`);
      b.value = value;
      return;
    }
    if (target.type === "MemberExpression") {
      const obj = (target.object.pure ? this.sx(target.object, env) : yield* this.expr(target.object, env));
      const key = yield* this.memberKey(target, env);
      this.setProp(obj, key, value);
      return;
    }
    yield* this.bindPattern(target, value, env, "assign");
  }

  // Bind a pattern (identifier or destructuring) to a value.
  // mode: "var" | "let" | "const" | "param" | "assign"
  *bindPattern(p, value, env, mode) {
    switch (p.type) {
      case "Identifier": {
        if (mode === "assign") return yield* this.assignTo(p, value, env);
        if (mode === "var") {
          const b = env.functionScope().vars.get(p.name) ?? env.lookup(p.name);
          if (b) b.value = value;
          else env.functionScope().declare(p.name, "var", value);
          return;
        }
        const own = env.vars.get(p.name);
        if (own && !own.init) {
          own.value = value;
          own.init = true;
        } else {
          env.declare(p.name, mode === "param" ? "let" : mode, value);
        }
        return;
      }
      case "MemberExpression":
        return yield* this.assignTo(p, value, env);
      case "AssignmentPattern": {
        let v = value;
        if (v === undefined) v = yield* this.namedExpr(p.right, env, p.left.type === "Identifier" ? p.left.name : undefined);
        return yield* this.bindPattern(p.left, v, env, mode);
      }
      case "ObjectPattern": {
        if (value === null || value === undefined) this.typeError(`Cannot destructure '${this.toStr(value)}' as it is ${value === null ? "null" : "undefined"}.`);
        const used = new Set();
        for (const prop of p.properties) {
          if (prop.type === "RestElement") {
            const rest = new GObj();
            for (const k of this.ownKeys(value)) if (!used.has(k)) rest.props.set(k, this.getProp(value, k));
            yield* this.bindPattern(prop.argument, rest, env, mode);
            continue;
          }
          const key = prop.computed ? this.toKey((prop.key.pure ? this.sx(prop.key, env) : yield* this.expr(prop.key, env))) : prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
          used.add(key);
          yield* this.bindPattern(prop.value, this.getProp(value, key), env, mode);
        }
        return;
      }
      case "ArrayPattern": {
        const items = this.iterate(value);
        for (let i = 0; i < p.elements.length; i++) {
          const el = p.elements[i];
          if (!el) continue;
          if (el.type === "RestElement") {
            yield* this.bindPattern(el.argument, new GArr(items.slice(i)), env, mode);
            break;
          }
          yield* this.bindPattern(el, items[i], env, mode);
        }
        return;
      }
    }
    this.throwError("SyntaxError", `Unsupported binding ${p.type}`);
  }

  // ---- calls ------------------------------------------------------------------

  *call(node, env) {
    let fn;
    let thisValue;
    const callee = node.callee;
    if (callee.type === "MemberExpression") {
      thisValue = (callee.object.pure ? this.sx(callee.object, env) : yield* this.expr(callee.object, env));
      if (callee.optional && (thisValue === null || thisValue === undefined)) throw SHORT_CIRCUIT;
      const key = yield* this.memberKey(callee, env);
      fn = this.getProp(thisValue, key);
      if (node.optional && (fn === null || fn === undefined)) throw SHORT_CIRCUIT;
      if (!isCallable(fn)) this.typeError(`${describe(callee)} is not a function`);
    } else {
      fn = (callee.pure ? this.sx(callee, env) : yield* this.expr(callee, env));
      if (node.optional && (fn === null || fn === undefined)) throw SHORT_CIRCUIT;
      if (!isCallable(fn)) this.typeError(`${describe(callee)} is not a function`);
    }
    const args = node.arguments.length === 0 ? [] : yield* this.evalArgs(node.arguments, env);
    // Fast path: a plain guest function skips one generator frame. Each frame
    // here costs real host stack, which limits how deep guest code can recurse.
    if (fn instanceof GFn && !fn.node.async) {
      if (--this.fuel <= 0) yield TICK;
      return yield* this.invoke(fn, thisValue, args);
    }
    return yield* this.callFunction(fn, thisValue, args);
  }

  *evalArgs(nodes, env) {
    const args = [];
    for (const a of nodes) {
      if (a.type === "SpreadElement") for (const v of this.iterate((a.argument.pure ? this.sx(a.argument, env) : yield* this.expr(a.argument, env)))) args.push(v);
      else args.push((a.pure ? this.sx(a, env) : yield* this.expr(a, env)));
    }
    return args;
  }

  *construct(node, env) {
    const ctor = (node.callee.pure ? this.sx(node.callee, env) : yield* this.expr(node.callee, env));
    const args = yield* this.evalArgs(node.arguments, env);
    if (ctor instanceof NFn && ctor.construct) return yield* ctor.construct(this, args);
    this.typeError(`${describe(node.callee)} is not a constructor. This runtime has no classes; use plain functions that return objects.`);
  }

  *callFunction(fn, thisValue, args) {
    if (--this.fuel <= 0) yield TICK;
    if (fn instanceof NFn) return yield* fn.impl(this, thisValue, args);
    if (fn instanceof GBound) return yield* this.callFunction(fn.target, fn.thisValue, [...fn.args, ...args]);
    if (fn instanceof ToolRef) return this.host.callTool(fn.path, args);
    if (!(fn instanceof GFn)) this.typeError(`${this.toStr(fn)} is not a function`);
    if (fn.isAsync) return yield* this.startAsync(fn, thisValue, args);
    return yield* this.invoke(fn, thisValue, args);
  }

  // Run a guest function body to completion (sync), or as the body of an async task.
  *invoke(fn, thisValue, args) {
    if (this.depth >= MAX_CALL_DEPTH) this.throwError("RangeError", "Maximum call stack size exceeded");
    this.depth++;
    try {
      const node = fn.node;
      const env = new Env(fn.env, true);
      if (!fn.isArrow) {
        env.declare("%this", "const", thisValue);
        if (node.usesArguments === undefined) node.usesArguments = mentions(node.body, "arguments");
        if (node.usesArguments) env.declare("arguments", "let", new GArr(args.slice()));
      }
      for (let i = 0; i < node.params.length; i++) {
        const p = node.params[i];
        if (p.type === "Identifier") {
          env.vars.set(p.name, { value: args[i], kind: "let", init: true });
          continue;
        }
        if (p.type === "RestElement") {
          yield* this.bindPattern(p.argument, new GArr(args.slice(i)), env, "param");
          break;
        }
        yield* this.bindPattern(p, args[i], env, "param");
      }
      if (node.expression) return (node.body.pure ? this.sx(node.body, env) : yield* this.expr(node.body, env));
      const body = node.body.body;
      this.hoist(body, env, env);
      for (let i = 0; i < body.length; i++) {
        const c = (body[i].simple ? this.stmtSync(body[i], env) : yield* this.stmt(body[i], env));
        if (c) return c.type === "return" ? c.value : undefined;
      }
      return undefined;
    } catch (e) {
      // Every guest call is a chain of host generators, so deep guest recursion
      // can overflow the *host* stack before MAX_CALL_DEPTH. Turn that into the
      // same catchable RangeError guest code would see in JavaScript.
      if (e instanceof RangeError && e.message === "Maximum call stack size exceeded") {
        throw new GuestThrow(this.makeError("RangeError", "Maximum call stack size exceeded"));
      }
      throw e;
    } finally {
      this.depth--;
    }
  }

  // ---- promises and tasks -------------------------------------------------------

  newPromise() {
    if (++this.pendingPromises > MAX_PENDING_PROMISES) {
      throw new Halt("ResourceLimit", `More than ${MAX_PENDING_PROMISES} promises created. Avoid creating promises in unbounded loops.`);
    }
    this.host.alloc(64);
    return new GPromise();
  }

  toPromise(v) {
    if (v instanceof GPromise) return v;
    const p = this.newPromise();
    this.resolve(p, v);
    return p;
  }

  // Calling an async function runs it synchronously up to its first await,
  // then returns a promise. The rest runs later as jobs.
  *startAsync(fn, thisValue, args) {
    const promise = this.newPromise();
    yield* this.stepTask({ gen: this.invoke(fn, thisValue, args), promise });
    return promise;
  }

  // Drive a task until it awaits something unfinished, or completes.
  *stepTask(task, input) {
    let resume = input;
    while (true) {
      let r;
      try {
        r = resume && !resume.ok ? task.gen.throw(new GuestThrow(resume.value)) : task.gen.next(resume?.value);
      } catch (e) {
        if (e instanceof GuestThrow) {
          this.reject(task.promise, e.value);
          return;
        }
        throw e;
      }
      resume = undefined;
      if (r.done) {
        this.resolve(task.promise, r.value);
        return;
      }
      if (r.value === TICK) {
        yield TICK;
        continue;
      }
      // An await: continue in a later job, once the promise settles.
      this.onSettle(r.value.await, (state, value) => {
        this.queueJob(this.stepTask(task, { ok: state === "fulfilled", value }));
      });
      return;
    }
  }

  queueJob(gen) {
    this.jobs.push(gen);
  }

  onSettle(p, callback) {
    if (p.state === "pending") p.reactions.push(callback);
    else callback(p.state, p.value);
  }

  resolve(p, value) {
    if (p.state !== "pending" || p.locked) return;
    if (value === p) return this.reject(p, this.makeError("TypeError", "Chaining cycle detected for promise"));
    if (value instanceof GPromise) {
      p.locked = true;
      value.handled = true;
      this.unhandled.delete(value);
      this.onSettle(value, (state, v) => this.queueJob((function* (self) {
        p.locked = false;
        if (state === "fulfilled") self.settle(p, "fulfilled", v);
        else self.settle(p, "rejected", v);
      })(this)));
      return;
    }
    this.settle(p, "fulfilled", value);
  }

  reject(p, reason) {
    if (p.state !== "pending" || p.locked) return;
    this.settle(p, "rejected", reason);
  }

  settle(p, state, value) {
    p.state = state;
    p.value = value;
    this.pendingPromises--;
    if (state === "rejected" && !p.handled && p.reactions.length === 0) this.unhandled.add(p);
    const reactions = p.reactions;
    p.reactions = [];
    for (const r of reactions) r(state, value);
  }

  // ---- property access ----------------------------------------------------------

  toKey(v) {
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    return this.toStr(v);
  }

  getProp(obj, key) {
    if (obj === null || obj === undefined) {
      this.typeError(`Cannot read properties of ${obj} (reading '${key}')`);
    }
    if (typeof key === "number") key = String(key);
    const methods = this.methods;
    if (typeof obj === "string") {
      if (key === "length") return obj.length;
      if (isIndex(key)) return obj[Number(key)];
      return methods.string[key];
    }
    if (typeof obj === "number") return methods.number[key];
    if (typeof obj === "boolean") return methods.boolean[key];
    if (obj instanceof GArr) {
      if (key === "length") return obj.items.length;
      if (isIndex(key)) return obj.items[Number(key)];
      if (obj.extra?.has(key)) return obj.extra.get(key); // regex match: index, input, groups
      return methods.array[key];
    }
    if (obj instanceof GObj) {
      if (obj.props.has(key)) return obj.props.get(key);
      if (obj instanceof GError && key === "stack") return `${obj.name}: ${obj.message}`;
      return methods.object[key];
    }
    if (obj instanceof ToolRef) {
      if (key === "then") return undefined; // never look like a promise
      return new ToolRef([...obj.path, key]);
    }
    if (obj instanceof GPromise) return methods.promise[key];
    if (obj instanceof GMap) return key === "size" ? obj.map.size : methods.map[key];
    if (obj instanceof GSet) return key === "size" ? obj.set.size : methods.set[key];
    if (obj instanceof GDate) return methods.date[key];
    if (obj instanceof GRegExp) {
      if (key === "source" || key === "flags" || key === "global" || key === "lastIndex") return obj.re[key];
      return methods.regexp[key];
    }
    if (obj instanceof NFn) {
      if (obj.props?.has(key)) return obj.props.get(key);
      if (key === "name") return obj.name;
      return methods.function[key];
    }
    if (obj instanceof GFn || obj instanceof GBound) {
      if (key === "name") return obj.name ?? "";
      if (key === "length") return obj.node?.params.length ?? 0;
      return methods.function[key];
    }
    return undefined;
  }

  setProp(obj, key, value) {
    if (obj === null || obj === undefined) this.typeError(`Cannot set properties of ${obj} (setting '${key}')`);
    if (obj instanceof GArr) {
      if (key === "length") {
        const n = toNumber(value);
        this.checkArrayLength(n);
        if (n < obj.items.length) obj.items.length = n;
        else while (obj.items.length < n) obj.items.push(undefined);
        return;
      }
      if (isIndex(key)) {
        const i = Number(key);
        this.checkArrayLength(i + 1);
        while (obj.items.length < i) obj.items.push(undefined);
        obj.items[i] = value;
        this.host.alloc(8);
        return;
      }
      this.typeError(`Cannot set property '${key}' on an array. Use an object for named fields.`);
    }
    if (obj instanceof GObj) {
      if (obj.frozen) this.typeError(`Cannot assign to read only property '${key}' of object`);
      if (!obj.props.has(key)) this.host.alloc(32);
      obj.props.set(key, value);
      return;
    }
    if (obj instanceof GRegExp && key === "lastIndex") {
      obj.re.lastIndex = toNumber(value);
      return;
    }
    this.typeError(`Cannot set property '${key}' on ${typeOf(obj)} value`);
  }

  ownKeys(v) {
    if (v instanceof GArr) return v.items.map((_, i) => String(i));
    if (v instanceof GObj) return [...v.props.keys()];
    if (typeof v === "string") return [...v].map((_, i) => String(i));
    return [];
  }

  // Everything `for...of`, spread and array destructuring can iterate.
  iterate(v) {
    if (v instanceof GArr) return v.items.slice();
    if (typeof v === "string") return [...v];
    if (v instanceof GMap) return [...v.map].map(([k, val]) => new GArr([k, val]));
    if (v instanceof GSet) return [...v.set];
    this.typeError(`${v === null || v === undefined ? v : typeOf(v)} is not iterable`);
  }

  // ---- conversions ------------------------------------------------------------

  toPrimitive(v) {
    if (v === null || typeof v !== "object") return v;
    if (v instanceof GDate) return v.time;
    return this.toStr(v);
  }

  toStr(v) {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v instanceof GArr) {
      return v.items.map((x) => (x === null || x === undefined ? "" : this.toStr(x))).join(",");
    }
    if (v instanceof GError) return `${this.toStr(v.name)}: ${this.toStr(v.message)}`;
    if (v instanceof GObj) return "[object Object]";
    if (v instanceof GDate) return Number.isNaN(v.time) ? "Invalid Date" : new Date(v.time).toISOString();
    if (v instanceof GRegExp) return String(v.re);
    if (v instanceof GPromise) return "[object Promise]";
    if (v instanceof GMap) return "[object Map]";
    if (v instanceof GSet) return "[object Set]";
    if (isCallable(v)) return "[object Function]";
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function truthy(v) {
  if (typeof v === "object") return v !== null;
  return Boolean(v);
}

export function toNumber(v) {
  if (typeof v === "number") return v;
  if (v === undefined) return NaN;
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return Number(v);
  if (v instanceof GDate) return v.time;
  if (v instanceof GArr) return v.items.length === 0 ? 0 : v.items.length === 1 ? toNumber(v.items[0]) : NaN;
  return NaN;
}

export function strictEquals(a, b) {
  return a === b;
}

export function isIndex(key) {
  if (typeof key === "number") return Number.isInteger(key) && key >= 0;
  return typeof key === "string" && key.length > 0 && key.length < 10 && /^(0|[1-9]\d*)$/.test(key);
}

// Does this subtree use an identifier (not counting nested non-arrow functions)?
function mentions(node, name) {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => mentions(n, name));
  if (node.type === "Identifier" && node.name === name) return true;
  if (node.type === "FunctionExpression" || node.type === "FunctionDeclaration") return false;
  for (const key of Object.keys(node)) {
    if (key !== "loc" && node[key] && typeof node[key] === "object" && mentions(node[key], name)) return true;
  }
  return false;
}

function describe(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed) return `${describe(node.object)}.${node.property.name}`;
  if (node.type === "MemberExpression") return `${describe(node.object)}[...]`;
  return "expression";
}
