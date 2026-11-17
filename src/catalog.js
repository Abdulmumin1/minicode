// Tools, their model-facing signatures, input validation, and search.
//
// A tool is { description, input?: JSONSchema, output?: JSONSchema, execute(input, { signal }) }.
// Tools are grouped in plain nested objects: { math: { add: tool } } -> tools.math.add

export function flattenTools(tree, prefix = [], out = new Map()) {
  for (const [name, value] of Object.entries(tree ?? {})) {
    const path = [...prefix, name];
    if (value && typeof value.execute === "function") out.set(path.join("."), { path, ...value });
    else if (value && typeof value === "object") flattenTools(value, path, out);
  }
  return out;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function toolExpression(path) {
  return "tools" + path.map((p) => (IDENT.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`)).join("");
}

// ---- JSON Schema -> TypeScript-ish text ---------------------------------------

export function schemaToTs(schema, indent = "") {
  if (!schema || schema === true) return "unknown";
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.anyOf || schema.oneOf) return (schema.anyOf ?? schema.oneOf).map((s) => schemaToTs(s, indent)).join(" | ");
  const type = schema.type;
  if (Array.isArray(type)) return type.map((t) => schemaToTs({ ...schema, type: t }, indent)).join(" | ");
  switch (type) {
    case "string": return "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": {
      const item = schemaToTs(schema.items, indent);
      return /[|&]/.test(item) ? `Array<${item}>` : `${item}[]`;
    }
    case "object":
    default: {
      const props = Object.entries(schema.properties ?? {});
      if (props.length === 0) return type === "object" ? "Record<string, unknown>" : "unknown";
      const required = new Set(schema.required ?? []);
      const inner = indent + "  ";
      const lines = props.map(([key, s]) => {
        const doc = s.description ? `${inner}/** ${s.description} */\n` : "";
        const name = IDENT.test(key) ? key : JSON.stringify(key);
        return `${doc}${inner}${name}${required.has(key) ? "" : "?"}: ${schemaToTs(s, inner)};`;
      });
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
  }
}

export function signature(tool) {
  const hasInput = tool.input && Object.keys(tool.input.properties ?? {}).length > 0;
  const input = hasInput ? `input: ${schemaToTs(tool.input)}` : "";
  const output = tool.output ? schemaToTs(tool.output) : "unknown";
  return `${toolExpression(tool.path)}(${input}): Promise<${output}>`;
}

// ---- Validation (a small, honest subset of JSON Schema) -----------------------

export function validate(schema, value, at = "input") {
  const errors = [];
  check(schema, value, at, errors);
  return errors;
}

function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function check(schema, value, at, errors) {
  if (!schema || schema === true) return;
  if (schema.anyOf || schema.oneOf) {
    const options = schema.anyOf ?? schema.oneOf;
    if (!options.some((s) => validate(s, value, at).length === 0)) errors.push(`${at} does not match any allowed shape`);
    return;
  }
  if (schema.enum && !schema.enum.some((v) => v === value)) {
    errors.push(`${at} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeName(value);
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) {
      errors.push(`${at} must be ${types.join(" or ")}, got ${actual}`);
      return;
    }
  }
  if (typeName(value) === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}.${key} is required`);
    for (const [key, v] of Object.entries(value)) {
      const s = schema.properties?.[key];
      if (s) check(s, v, `${at}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}.${key} is not allowed`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => check(schema.items, v, `${at}[${i}]`, errors));
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at} must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at} must have at most ${schema.maxLength} characters`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at} must be <= ${schema.maximum}`);
  }
}

// ---- Search -------------------------------------------------------------------

const words = (text) =>
  String(text)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export function searchTools(registry, { query = "", namespace, limit = 10, offset = 0 } = {}) {
  let entries = [...registry.values()];
  if (namespace) entries = entries.filter((t) => t.path[0] === namespace);
  const q = String(query).trim();
  const exact = entries.find((t) => t.path.join(".") === q.replace(/^tools\./, ""));
  let ranked;
  if (exact) {
    ranked = [exact];
  } else {
    const terms = words(q);
    ranked = entries
      .map((t) => {
        const name = words(t.path.at(-1));
        const path = words(t.path.join(" "));
        const desc = words(t.description ?? "");
        let score = 0;
        for (const term of terms) {
          if (name.includes(term)) score += 3;
          else if (path.includes(term)) score += 2;
          else if (desc.includes(term)) score += 1;
          else if ([...name, ...path, ...desc].some((w) => w.startsWith(term))) score += 0.5;
        }
        return { t, score };
      })
      .filter((x) => terms.length === 0 || x.score > 0)
      .sort((a, b) => b.score - a.score || a.t.path.join(".").localeCompare(b.t.path.join(".")))
      .map((x) => x.t);
  }
  const page = ranked.slice(offset, offset + limit);
  const remaining = Math.max(0, ranked.length - offset - page.length);
  return {
    items: page.map((t) => ({ path: toolExpression(t.path), description: t.description ?? "", signature: signature(t) })),
    remaining,
    next: remaining > 0 ? { offset: offset + page.length } : null,
  };
}

// The text you would put in a model's system prompt.
export function describeCatalog(registry) {
  const lines = [...registry.values()].map((t) => `// ${t.description ?? ""}\n${signature(t)}`);
  return lines.join("\n\n");
}
