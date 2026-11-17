// Renders post/diagrams/*.mmd to PNG in the yaqeen.me diagram style:
// mermaid's handDrawn look, the light "paper and ink" palette, Virgil labels,
// and the danger / control / active / muted tints, copied from
// yaqeen.me src/lib/utils/mermaid.js and src/app.css.
import { readFileSync, readdirSync } from "node:fs";
import { chromium } from "playwright";

const root = new URL("../", import.meta.url).pathname;
const fonts = `${root}style/fonts/`;
const dir = `${root}post/diagrams/`;
const out = `${root}post/assets/`;

const palette = {
  background: "#fff7ed", primaryColor: "#efe6da", primaryTextColor: "#1c1917", primaryBorderColor: "#57534e",
  secondaryColor: "#f3ece3", secondaryTextColor: "#3d3935", secondaryBorderColor: "#a8a29e",
  tertiaryColor: "#fff7ed", tertiaryTextColor: "#57534e", tertiaryBorderColor: "#d6cfc7",
  lineColor: "#8f8780", textColor: "#1c1917", mainBkg: "#efe6da", nodeBorder: "#57534e",
  clusterBkg: "transparent", clusterBorder: "transparent", edgeLabelBackground: "#fff7ed",
  noteBkgColor: "#f3ece3", noteBorderColor: "#a8a29e", noteTextColor: "#3d3935", fontSize: "14px",
};

const config = {
  startOnLoad: false, theme: "base", look: "handDrawn", securityLevel: "loose",
  fontFamily: "Virgil, Comic Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
  themeVariables: palette,
  flowchart: { curve: "linear", nodeSpacing: 42, rankSpacing: 54, padding: 18, useMaxWidth: false, htmlLabels: true },
  sequence: { diagramMarginX: 32, diagramMarginY: 24, actorMargin: 64, messageMargin: 36, useMaxWidth: false },
};

const css = `
@font-face { font-family: 'Virgil'; src: url(data:font/woff2;base64,${readFileSync(fonts + "Virgil.woff2").toString("base64")}) format('woff2'); }
body { margin: 0; background: #fff7ed; }
#wrap { display: inline-block; padding: 28px 36px; background: #fff7ed; }
.mermaid { --diagram-fill: #efe6da; --diagram-line: #57534e; }
.mermaid .node rect, .mermaid .node circle, .mermaid .node polygon { stroke-width: 1.5px; }
.mermaid .nodeLabel, .mermaid .edgeLabel, .mermaid .cluster-label, .mermaid text {
  font-family: 'Virgil', 'Comic Mono', ui-monospace, monospace !important; letter-spacing: -0.02em; }
.mermaid .edgeLabel { font-size: 0.78rem; }
.mermaid .edgeLabel rect { rx: 6px; ry: 6px; opacity: 0.92 !important; }
.mermaid .flowchart-link { stroke-width: 1.5px; }
.mermaid .rough-node path[stroke-width='4'] { stroke: var(--diagram-fill) !important; }
.mermaid .rough-node path:not([stroke-width='4']) { stroke: var(--diagram-line) !important; }
.mermaid .rough-node.danger { --diagram-fill: #f8d9cd; --diagram-line: #b4380f; }
.mermaid .rough-node.control { --diagram-fill: #dfdcf6; --diagram-line: #4a40ad; }
.mermaid .rough-node.active { --diagram-fill: #dbe7c8; --diagram-line: #4a6b1e; }
.mermaid .rough-node.muted { --diagram-fill: #ece7e1; --diagram-line: #a8a29e; }
`;

const browser = await chromium.launch({ channel: "chrome" });
const only = process.argv[2];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".mmd")).sort()) {
  if (only && !file.includes(only)) continue;
  const source = readFileSync(dir + file, "utf8");
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  await page.setContent(`<html><head><style>${css}</style></head><body><div id="wrap"><pre class="mermaid"></pre></div></body></html>`);
  await page.addScriptTag({ path: `${root}style/vendor/mermaid.min.js` });
  await page.evaluate(async ({ source, config }) => {
    await document.fonts.load("16px Virgil");
    const el = document.querySelector(".mermaid");
    el.textContent = source;
    window.mermaid.initialize(config);
    await window.mermaid.run({ nodes: [el] });
  }, { source, config });
  const wrap = await page.$("#wrap");
  const png = out + file.replace(/\.mmd$/, ".png");
  await wrap.screenshot({ path: png });
  await page.close();
  console.log("rendered", file);
}
await browser.close();
