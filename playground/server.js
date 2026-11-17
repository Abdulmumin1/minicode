// The playground: `npm start`, then open http://localhost:3000

import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { createRuntime } from "../src/index.js";
import { demoTools } from "./tools.js";

const PORT = Number(process.env.PORT) || 3000;
const root = new URL("../", import.meta.url);
const page = () => readFileSync(new URL("playground/index.html", root), "utf8");

const runtime = createRuntime({
  tools: demoTools,
  limits: { timeoutMs: 3000, maxToolCalls: 50, maxOutputBytes: 20_000, maxHeapGrowthMB: 256 },
});

const examples = () =>
  readdirSync(new URL("examples/", root))
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((name) => ({ name, code: readFileSync(new URL(`examples/${name}`, root), "utf8") }));

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page());
  }
  if (req.method === "GET" && /^\/fonts\/[\w.-]+\.woff2$/.test(path)) {
    try {
      const font = readFileSync(new URL(`style${path}`, root));
      res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=86400" });
      return res.end(font);
    } catch {
      return json(res, 404, { error: "Not found" });
    }
  }
  if (req.method === "GET" && req.url === "/api/examples") return json(res, 200, examples());
  if (req.method === "GET" && req.url === "/api/catalog") return json(res, 200, { text: runtime.describe() });
  if (req.method === "GET" && req.url === "/api/ping") return json(res, 200, { t: Date.now() });

  if (req.method === "POST" && req.url === "/api/run") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 100_000) return json(res, 413, { error: "Program too large" });
    }
    const { code = "" } = JSON.parse(body || "{}");
    const controller = new AbortController();
    res.on("close", () => controller.abort()); // closing the tab stops the run
    return json(res, 200, await runtime.execute(code, { signal: controller.signal }));
  }
  json(res, 404, { error: "Not found" });
}).listen(PORT, () => console.log(`minicode playground: http://localhost:${PORT}`));
