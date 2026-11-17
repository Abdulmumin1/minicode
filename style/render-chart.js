// Hand-drawn benchmark chart in the yaqeen.me diagram style (rough.js hatching,
// Virgil labels, the paper-and-ink palette and its tints).
// Reads bench/results/*.json, writes post/assets/07-benchmarks.png
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const root = new URL("../", import.meta.url).pathname;
const load = (f) => JSON.parse(readFileSync(`${root}bench/results/${f}`, "utf8"));
const series = [
  { name: "plain V8, no sandbox", file: "native-node.json", fill: "#ece7e1", line: "#a8a29e" },
  { name: "OpenCode's VM (Bun)", file: "opencode-bun.json", fill: "#dfdcf6", line: "#4a40ad" },
  { name: "minicode (Node)", file: "minicode-node.json", fill: "#dbe7c8", line: "#4a6b1e" },
  { name: "node:vm + worker", file: "v1-node-vm.json", fill: "#f8d9cd", line: "#b4380f" },
].map((s) => ({ ...s, data: load(s.file) }));
const programs = Object.keys(series[0].data);
const virgil = readFileSync(`${root}style/fonts/Virgil.woff2`).toString("base64");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1200, height: 1100 }, deviceScaleFactor: 2 });
await page.setContent(`<html><head><style>
  @font-face { font-family: Virgil; src: url(data:font/woff2;base64,${virgil}) format('woff2'); }
  body { margin: 0; background: #fff7ed; }
  svg text { font-family: Virgil, ui-monospace, monospace; fill: #1c1917; }
</style></head><body><svg id="c" xmlns="http://www.w3.org/2000/svg"></svg></body></html>`);
await page.addScriptTag({ path: `${root}style/vendor/rough.js` });
await page.evaluate(async ({ series, programs }) => {
  await document.fonts.load("16px Virgil");
  const W = 1100, left = 220, right = 90, top = 120, rowH = 22, gap = 26;
  const H = top + programs.length * (series.length * rowH + gap) + 56;
  const svg = document.getElementById("c");
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  const rc = rough.svg(svg);
  const NS = "http://www.w3.org/2000/svg";
  const text = (x, y, s, { size = 15, anchor = "start", color = "#1c1917" } = {}) => {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", x); t.setAttribute("y", y); t.setAttribute("font-size", size);
    t.setAttribute("text-anchor", anchor); t.style.fill = color; t.textContent = s;
    svg.appendChild(t);
  };
  const min = 0.1, max = 1000;
  const x = (ms) => left + ((Math.log10(Math.max(ms, min)) - Math.log10(min)) / (Math.log10(max) - Math.log10(min))) * (W - left - right);

  text(36, 44, "Same programs, four runtimes", { size: 26 });
  text(36, 72, "median of 7 runs, in ms, log scale. Shorter is faster.", { size: 15, color: "#57534e" });
  series.forEach((s, i) => {
    const lx = 36 + i * 262;
    svg.appendChild(rc.rectangle(lx, 88, 18, 14, { fill: s.fill, stroke: s.line, fillStyle: "hachure", hachureGap: 4, roughness: 1.2, seed: 7 + i }));
    text(lx + 26, 100, s.name, { size: 15 });
  });
  for (const tick of [0.1, 1, 10, 100, 1000]) {
    svg.appendChild(rc.line(x(tick), top - 10, x(tick), H - 44, { stroke: "#d6cfc7", strokeWidth: 1, roughness: 0.6, seed: 3 }));
    text(x(tick), H - 22, `${tick} ms`, { size: 13, anchor: "middle", color: "#78716c" });
  }
  let y = top;
  let seed = 11;
  for (const p of programs) {
    text(left - 16, y + (series.length * rowH) / 2 + 5, p, { size: 15, anchor: "end" });
    for (const s of series) {
      const ms = s.data[p].ms;
      const w = Math.max(x(ms) - left, 3);
      svg.appendChild(rc.rectangle(left, y + 3, w, rowH - 7, {
        fill: s.fill, stroke: s.line, fillStyle: "hachure", hachureGap: 5, hachureAngle: -41, fillWeight: 1.4, strokeWidth: 1.3, roughness: 1.1, seed: seed++,
      }));
      const label = ms === 0 ? "<0.01" : ms < 1 ? String(ms) : String(Math.round(ms * 10) / 10);
      text(left + w + 8, y + rowH - 7, label, { size: 13, color: "#57534e" });
      y += rowH;
    }
    y += gap;
  }
}, { series: series.map(({ name, fill, line, data }) => ({ name, fill, line, data })), programs });
const svg = await page.$("#c");
await svg.screenshot({ path: `${root}post/assets/07-benchmarks.png` });
await browser.close();
console.log("rendered 07-benchmarks.png");
