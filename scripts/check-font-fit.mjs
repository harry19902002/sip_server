/**
 * 检查字号放大后是否有容器高度不足（文字被裁切 / 溢出）。
 *
 * 思路：解析 app/globals.css，对每条带 font-size 和固定 height 的规则，
 * 按中文行高约 1.45 倍估算单行所需高度，超出则报告。
 *
 * 用法：node scripts/check-font-fit.mjs
 */

import fs from "node:fs";
import path from "node:path";

const CSS_PATH = path.join(process.cwd(), "app", "globals.css");
const css = fs.readFileSync(CSS_PATH, "utf8");

const ruleRe = /(^|\n)([^{}\n][^{}]*?)\{([^{}]*)\}/g;
const rules = [];
let match;
while ((match = ruleRe.exec(css))) {
  rules.push({ selector: match[2].trim(), body: match[3] });
}

const num = (body, prop) => {
  const found = body.match(new RegExp(prop + ":\\s*([0-9.]+)px"));
  return found ? parseFloat(found[1]) : null;
};

// 中文正文行高经验值；加 6px 作为上下内边距余量
const LINE_HEIGHT = 1.45;
const PADDING = 6;

// 装符号而非文字的容器：勾选框、圆形序号、图标按钮等
const GLYPH_SELECTORS = [
  ".custom-check",
  ".source-check",
  ".terminal-check i",
  ".precheck-box > span",
  ".step > span",
  ".shortcut-order",
  ".shortcut-editing-note > span",
  ".backup-notice > span",
  ".backup-readonly > span",
  ".task-notice > span",
  ".schedule-history-mark",
  ".zone-symbol",
  ".zone-folder",
  ".theme-options em",
  ".play-circle",
  ".media-play-button",
  ".modal-close",
  ".sip-server-mark",
  ".role-head",
  ".organization-banner-mark",
  ".organization-preview-mark",
  ".list-mark",
  ".terminal-device-icon",
  ".target-terminal-icon",
  ".codec-move button",
  ".schedule-targets button > i",
];

const risky = [];
for (const rule of rules) {
  const fontSize = num(rule.body, "font-size");
  if (!fontSize) continue;

  const height = num(rule.body, "height");
  if (!height) continue;

  // 徽标类元素显式用 line-height: 1 做垂直居中，不适用中文 1.45 倍行高
  if (/line-height:\s*1\s*[;}]/.test(rule.body)) continue;

  const needed = fontSize * LINE_HEIGHT + PADDING;
  if (height >= needed) continue;

  risky.push({
    selector: rule.selector,
    fontSize,
    height,
    needed: Math.round(needed * 10) / 10,
    clips: /overflow:\s*hidden/.test(rule.body),
    // 勾选框、圆形序号、开关这类元素装的是单个符号（✓ ▦ ◖），
    // 符号没有中文字形那么高的升部/降部，不需要完整行高，属于误报。
    isGlyph: GLYPH_SELECTORS.some((g) => rule.selector.includes(g)),
  });
}

const real = risky.filter((r) => !r.isGlyph);
const glyphs = risky.filter((r) => r.isGlyph);

real.sort((a, b) => b.needed - b.height - (a.needed - a.height));

console.log(`高度可能不足的规则：${real.length} 条需要处理，${glyphs.length} 条是符号容器（可忽略）\n`);
for (const r of real) {
  const tag = r.clips ? " [overflow:hidden]" : "";
  console.log(
    `  ${String(r.fontSize).padStart(4)}px 文字 / 高 ${String(r.height).padStart(4)}px / 需 ${String(r.needed).padStart(5)}px${tag}\n        ${r.selector}`
  );
}

if (real.length === 0) {
  console.log("  没有需要处理的规则。");
}

if (glyphs.length) {
  console.log("\n符号容器（装的是 ✓ / 序号 / 图标，不是正文）：");
  for (const r of glyphs) {
    console.log(`  ${String(r.fontSize).padStart(4)}px @ 高${String(r.height).padStart(3)}px   ${r.selector}`);
  }
}
