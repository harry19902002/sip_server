/**
 * 检查行距覆盖率与偏紧的行高。
 *
 * 中文正文在 13px 下需要约 1.6 倍行高才不显拥挤；表格/徽标等单行元素
 * 可以更紧，但带 <p>/<small> 的正文块不应低于 1.5。
 *
 * 用法：node scripts/check-line-height.mjs
 */

import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");

const ruleRe = /(^|\n)([^{}\n][^{}]*?)\{([^{}]*)\}/g;
const rules = [];
let match;
while ((match = ruleRe.exec(css))) {
  rules.push({ selector: match[2].trim(), body: match[3] });
}

const fonts = rules.filter((r) => /font-size:/.test(r.body));
const withLH = fonts.filter((r) => /line-height:/.test(r.body));
const withUnitlessLH = fonts.filter((r) => /line-height:\s*[0-9.]+[;}\s]/.test(r.body));

console.log(`含 font-size 的规则：${fonts.length} 条`);
console.log(`  显式声明 line-height：${withLH.length} 条（${((withLH.length / fonts.length) * 100).toFixed(0)}%）`);
console.log(`  其中无单位系数：${withUnitlessLH.length} 条\n`);

// 找出「正文类」选择器——含 p / small / span / li / dd，且行高偏紧
const tight = [];
for (const rule of rules) {
  const sizeM = rule.body.match(/font-size:\s*([0-9.]+)px/);
  const lhM = rule.body.match(/line-height:\s*([0-9.]+)/);
  if (!sizeM || !lhM) continue;
  const size = parseFloat(sizeM[1]);
  let lh = lhM[1];
  // line-height 带 px 时换算成倍数
  const isPx = /line-height:\s*[0-9.]+px/.test(rule.body);
  const factor = isPx ? parseFloat(lh) / size : parseFloat(lh);
  if (factor < 1.45) {
    tight.push({ selector: rule.selector, size, factor: +factor.toFixed(2) });
  }
}

if (tight.length) {
  console.log("行高偏紧的规则（< 1.45 倍）：");
  for (const t of tight) {
    console.log(`  ${t.factor}倍 @ ${t.size}px   ${t.selector}`);
  }
} else {
  console.log("没有低于 1.45 倍行高的规则。");
}
