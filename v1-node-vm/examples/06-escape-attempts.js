// Try to break out. Every one of these should fail.
const attempts = {
  require: () => require("fs"),
  process: () => process.env,
  setTimeout: () => setTimeout(() => {}, 10),
  eval: () => eval("1 + 1"),
  newFunction: () => new Function("return 1")(),
  viaTools: () => tools.constructor.constructor("return process")(),
  viaToolFn: () => tools.math.add.constructor("return process")(),
  viaGlobal: () => globalThis.constructor.constructor("return process")(),
  viaThis: () => this.constructor.constructor("return process")(),
  viaConsole: () => console.log.constructor("return process")(),
  viaPromise: () => tools.math.add({ a: 1, b: 1 }).constructor.constructor("return process")(),
  viaProto: () => Object.getPrototypeOf(globalThis).constructor.constructor("return process")(),
};

const report = {};
for (const [name, attempt] of Object.entries(attempts)) {
  try {
    const value = attempt();
    report[name] = `ESCAPED?! got ${typeof value}`;
  } catch (e) {
    report[name] = `blocked: ${e.message}`;
  }
}
return report;
