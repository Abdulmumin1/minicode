// The tool registry. Every tool lives in a namespace and has a description,
// a signature (just documentation for the model/human), and a `run` function.
// Tools ALWAYS run on the host, never inside the sandbox.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const notes = new Map();

export const tools = {
  math: {
    add: {
      description: "Add two numbers.",
      signature: "({ a: number, b: number }) => number",
      run: ({ a, b }) => a + b,
    },
    multiply: {
      description: "Multiply two numbers.",
      signature: "({ a: number, b: number }) => number",
      run: ({ a, b }) => a * b,
    },
  },

  weather: {
    get: {
      description: "Get the (fake) current weather for a city. Takes ~300ms.",
      signature: "({ city: string }) => { city, tempC, sky }",
      run: async ({ city }) => {
        await wait(300);
        if (!city) throw new Error("city is required");
        const seed = [...city.toLowerCase()].reduce((n, c) => n + c.charCodeAt(0), 0);
        const skies = ["sunny", "cloudy", "rainy", "stormy"];
        return { city, tempC: 15 + (seed % 20), sky: skies[seed % skies.length] };
      },
    },
  },

  notes: {
    save: {
      description: "Save a note by title (overwrites).",
      signature: "({ title: string, body: string }) => { saved: string }",
      run: ({ title, body }) => {
        notes.set(title, body);
        return { saved: title };
      },
    },
    list: {
      description: "List all note titles.",
      signature: "() => string[]",
      run: () => [...notes.keys()],
    },
    read: {
      description: "Read one note. Returns null if missing.",
      signature: "({ title: string }) => string | null",
      run: ({ title }) => notes.get(title) ?? null,
    },
  },
};

export function catalog(registry = tools) {
  const out = [];
  for (const [ns, group] of Object.entries(registry)) {
    for (const [name, tool] of Object.entries(group)) {
      out.push({
        path: `tools.${ns}.${name}`,
        description: tool.description,
        signature: tool.signature,
      });
    }
  }
  return out;
}

export function findTool(registry, path) {
  const [ns, name] = path.replace(/^tools\./, "").split(".");
  return registry[ns]?.[name];
}

export function searchTools(registry, { query = "", limit = 10 } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const scored = catalog(registry)
    .map((t) => {
      const text = `${t.path} ${t.description}`.toLowerCase();
      const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
      return { ...t, score };
    })
    .filter((t) => words.length === 0 || t.score > 0)
    .sort((a, b) => b.score - a.score);
  return { items: scored.slice(0, limit).map(({ score, ...t }) => t) };
}
