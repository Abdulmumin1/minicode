// A tiny web playground: `npm start`, then open http://localhost:3000

import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { runCode } from "./sandbox.js";
import { catalog } from "./tools.js";

const PORT = Number(process.env.PORT) || 3000;
const root = new URL("../", import.meta.url);
const page = readFileSync(new URL("public/index.html", root), "utf8");

function loadExamples() {
  const dir = new URL("examples/", root);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((name) => ({ name, code: readFileSync(new URL(name, dir), "utf8") }));
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page);
  }
  if (req.method === "GET" && req.url === "/api/catalog") return json(res, 200, catalog());
  if (req.method === "GET" && req.url === "/api/examples") return json(res, 200, loadExamples());

  if (req.method === "POST" && req.url === "/api/run") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 100_000) return json(res, 413, { error: "Code too large" });
    }
    const { code = "" } = JSON.parse(body || "{}");
    const out = await runCode(code, { allowedFetchHosts: ["api.github.com"] });
    return json(res, 200, out);
  }

  json(res, 404, { error: "Not found" });
}).listen(PORT, () => console.log(`Code Mode sandbox running at http://localhost:${PORT}`));
