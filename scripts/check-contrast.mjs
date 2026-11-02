/**
 * 从 app/globals.css 读取真实配色，检查文字对比度是否达到 WCAG AA。
 *
 * 不硬编码颜色——变量改了就要跟着变，否则检查形同虚设。
 * 小字号正文（≤14px）按 normal text 处理，AA 要求 4.5:1。
 *
 * 用法：node scripts/check-contrast.mjs
 */

import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");

/** 取出某个作用域（:root 或 html[data-theme="dark"]）下的变量表 */
function readVars(scopePattern) {
  const block = css.match(scopePattern);
  if (!block) throw new Error(`找不到作用域: ${scopePattern}`);
  const vars = {};
  for (const m of block[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    vars[m[1]] = m[2];
  }
  return vars;
}

const light = readVars(/:root\s*\{([\s\S]*?)\}/);
const dark = readVars(/html\[data-theme="dark"\]\s*\{([\s\S]*?)\}/);

const toRgb = (value) => {
  const clean = value.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

const luminance = ([r, g, b]) => {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const ratio = (fg, bg) => {
  const a = luminance(toRgb(fg));
  const b = luminance(toRgb(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

// 文字变量 × 常见底色。底色都取自实际样式表用到的背景。
const backgrounds = {
  surface: (v) => v.surface,
  canvas: (v) => v.canvas,
  blueSoft: (v) => v["blue-soft"],
  greenSoft: (v) => v["green-soft"],
  orangeSoft: (v) => v["orange-soft"],
};

const textVars = ["text", "text-1", "text-2", "text-3"];

const AA = 4.5;
const rows = [];
let failures = 0;

for (const [themeName, vars] of [
  ["亮色", light],
  ["暗色", dark],
]) {
  for (const name of textVars) {
    const fg = vars[name];
    if (!fg) continue;
    for (const [bgName, resolve] of Object.entries(backgrounds)) {
      const bg = resolve(vars);
      if (!bg) continue;
      const value = ratio(fg, bg);
      // --text / --text-1 是主文字，颜色深；只关注所有组合中最差的那个
      if (value < AA) {
        failures += 1;
        rows.push({ theme: themeName, name, bgName, fg, bg, value });
      }
    }
  }
}

console.log("对比度检查（AA normal text ≥ 4.5:1）\n");
if (rows.length === 0) {
  console.log("  全部通过。");
} else {
  for (const r of rows.sort((a, b) => a.value - b.value)) {
    console.log(
      `  FAIL ${r.value.toFixed(2).padStart(5)}:1  ${r.theme} --${r.name} (${r.fg}) on --${r.bgName} (${r.bg})`
    );
  }
  console.log(`\n不合格 ${failures} 项`);
}

// 顺带输出关键变量的实际取值，便于人工确认
console.log("\n关键变量：");
for (const [theme, vars] of [["亮色", light], ["暗色", dark]]) {
  console.log(
    `  ${theme}: text=${vars.text} text-2=${vars["text-2"]} text-3=${vars["text-3"]}`
  );
}
