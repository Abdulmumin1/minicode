// Demo tools for the playground. Tools always run on the host.

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("interrupted"));
    });
  });

const notes = new Map([["welcome", "Notes live on the host. The program only sees copies."]]);

export const demoTools = {
  math: {
    add: {
      description: "Add two numbers.",
      input: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      output: { type: "number" },
      execute: ({ a, b }) => a + b,
    },
  },
  weather: {
    get: {
      description: "Get the current (fake) weather for a city. Takes about 400 ms.",
      input: {
        type: "object",
        properties: { city: { type: "string", minLength: 1, description: "City name, e.g. Lagos" } },
        required: ["city"],
      },
      output: {
        type: "object",
        properties: { city: { type: "string" }, tempC: { type: "number" }, sky: { type: "string" } },
      },
      execute: async ({ city }, { signal }) => {
        await wait(300 + Math.random() * 200, signal);
        const seed = [...city.toLowerCase()].reduce((n, c) => n + c.charCodeAt(0), 0);
        return { city, tempC: 12 + (seed % 22), sky: ["sunny", "cloudy", "rainy", "stormy"][seed % 4] };
      },
    },
  },
  notes: {
    save: {
      description: "Save a note by title (overwrites).",
      input: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title", "body"],
      },
      execute: ({ title, body }) => {
        notes.set(title, body);
        return { saved: title };
      },
    },
    list: {
      description: "List all note titles.",
      output: { type: "array", items: { type: "string" } },
      execute: () => [...notes.keys()],
    },
    read: {
      description: "Read a note. Returns null if it doesn't exist.",
      input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      output: { type: ["string", "null"] },
      execute: ({ title }) => notes.get(title) ?? null,
    },
  },
  users: {
    find: {
      description: "Find users by country. Returns ids only; use users.get for details. Takes ~150 ms.",
      input: { type: "object", properties: { country: { type: "string" } }, required: ["country"] },
      output: { type: "array", items: { type: "number" } },
      execute: async ({ country }, { signal }) => {
        await wait(150, signal);
        return country.toLowerCase() === "ng" ? [1, 2, 3, 4, 5, 6] : [7, 8];
      },
    },
    get: {
      description: "Get one user's profile. Takes ~200 ms.",
      input: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      output: {
        type: "object",
        properties: { id: { type: "number" }, name: { type: "string" }, plan: { type: "string" }, spend: { type: "number" } },
      },
      execute: async ({ id }, { signal }) => {
        await wait(150 + id * 15, signal);
        const names = ["Ada", "Tunde", "Ngozi", "Emeka", "Zainab", "Bola", "Sam", "Lin"];
        return { id, name: names[id - 1], plan: id % 3 === 0 ? "pro" : "free", spend: id * 1234 % 5000 };
      },
    },
  },
};
