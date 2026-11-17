// Screenshots and a short screen recording of the playground, for the post.
// Usage: node scripts/capture.js   (starts its own playground server)
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { chromium } from "playwright";

const PORT = 3917;
const OUT = new URL("../post/assets/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, ["playground/server.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
await new Promise((resolve) => server.stdout.once("data", resolve));
const url = (example) => `http://localhost:${PORT}/?example=${example}`;

const browser = await chromium.launch({ channel: "chrome" });

async function shot(example, file, { wait = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(url(example));
  await page.waitForFunction(() => document.getElementById("code").value.length > 0);
  await page.click("#run");
  await page.waitForSelector("#badge.ok, #badge.bad", { timeout: 15_000 });
  if (wait) await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}${file}` });
  await page.close();
  console.log("saved", file);
}

await shot("02-parallel-tools.js", "playground-parallel.png");
await shot("05-escape-attempts.js", "playground-escapes.png");
await shot("06-runaway.js", "playground-runaway.png");
await shot("07-memory-bomb.js", "playground-memory-bomb.png");
await shot("08-forgot-await.js", "playground-forgot-await.png");

// A short video: parallel tools, then a runaway loop with the server still answering.
const videoDir = `${OUT}video-tmp/`;
rmSync(videoDir, { recursive: true, force: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 760 } } });
const page = await context.newPage();
await page.goto(url("02-parallel-tools.js"));
await page.waitForFunction(() => document.getElementById("code").value.length > 0);
await page.waitForTimeout(1200);
await page.click("#run");
await page.waitForSelector("#badge.ok");
await page.waitForTimeout(2200);
await page.selectOption("#examples", { label: "06-runaway.js" });
await page.waitForTimeout(1200);
await page.click("#run");
await page.waitForSelector("#badge.bad", { timeout: 10_000 });
await page.waitForTimeout(2200);
await page.selectOption("#examples", { label: "05-escape-attempts.js" });
await page.waitForTimeout(1000);
await page.click("#run");
await page.waitForSelector("#badge.ok");
await page.waitForTimeout(2500);
await context.close();
const [webm] = readdirSync(videoDir);
renameSync(`${videoDir}${webm}`, `${OUT}playground-demo.webm`);
rmSync(videoDir, { recursive: true, force: true });
console.log("saved playground-demo.webm");

await browser.close();
server.kill();
