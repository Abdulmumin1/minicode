// Try to break out. In a node:vm sandbox, one of these reaches `process`.
// Here there is nothing to reach: these names don't exist, and objects have
// no prototype chain to climb.
const attempts = {
  "process": () => process.env,
  "require": () => require("fs"),
  "globalThis": () => globalThis,
  "eval": () => eval("1 + 1"),
  "({}).constructor": () => ({}).constructor,
  "fn.constructor(...)": () => (() => 1).constructor("return process")(),
  "tools.constructor(...)": () => tools.constructor.constructor("return process")(),
  "Object.getPrototypeOf": () => Object.getPrototypeOf({}),
  "({}).__proto__": () => ({}).__proto__,
};

const report = {};
for (const [name, attempt] of Object.entries(attempts)) {
  try {
    report[name] = `returned ${typeof attempt()}`;
  } catch (e) {
    report[name] = `${e.name}: ${e.message}`;
  }
}
return report;
