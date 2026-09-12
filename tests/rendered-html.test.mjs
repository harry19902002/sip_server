import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the SIP broadcast management platform", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>SIP广播系统 · 管理平台<\/title>/i);
  assert.match(html, /正在验证登录状态/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/i);
});

test("keeps core management surfaces in the application source", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /function Overview\(/);
  assert.match(page, /function Realtime\(/);
  assert.match(page, /function Schedule\(/);
  assert.match(page, /function Terminals\(/);
  assert.match(page, /function SipAccounts\(/);
  assert.match(page, /亮色风格/);
  assert.match(page, /暗色风格/);
  assert.match(page, /onThemeChange/);
  assert.match(layout, /title:\s*"SIP广播系统 · 管理平台"/);
  assert.match(packageJson, /"name": "sip-broadcast-system"/);
});

test("no component reads a const before it is declared", async () => {
  // 回归测试：曾出现 Realtime 里 `playModeLabel` 在 `playMode` state 声明之前计算：
  //   const playModeLabel = playModeOptions.find((o) => o.key === playMode)?.label
  // 引用发生在回调内，TypeScript 的"先用后声明"检查不报错，但 `.find` 在渲染时
  // 同步执行 → TDZ（Cannot access 'playMode' before initialization）→ 整页崩溃。
  //
  // 这里做静态检查：同一组件内，某行不得读取仅在更靠后行才声明的标识符。
  // 注意：这是保守启发式，可能对"延迟执行的闭包内引用后声明变量"产生误报
  // （那种写法在 JS 里合法）；当前代码库没有该模式，故保持严格。出现误报时
  // 应针对性地放宽，而不是删掉这条测试。
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const lines = page.split(/\r?\n/);

  // 去掉行注释与字符串字面量，避免注释/文案里的同名文字造成误报
  const stripNoise = (line) =>
    line
      .replace(/\/\/.*$/, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");

  const componentStarts = [];
  lines.forEach((line, index) => {
    // 允许 `export default function Home(` 这类前缀，否则组件边界会漏判，
    // 把后一个组件的声明误并入前一个组件，产生假报。
    const match = /\bfunction ([A-Z][A-Za-z0-9_]*)\(/.exec(line);
    if (match) componentStarts.push({ name: match[1], line: index });
  });
  componentStarts.push({ name: "<eof>", line: lines.length });

  const problems = [];
  for (let c = 0; c < componentStarts.length - 1; c += 1) {
    const start = componentStarts[c].line;
    const end = componentStarts[c + 1].line;

    // 收集该组件内所有 const 声明的标识符 → 声明所在行
    const declared = new Map();
    for (let i = start; i < end; i += 1) {
      const code = stripNoise(lines[i]);
      const fromPair = /const \[([A-Za-z0-9_]+),\s*set[A-Za-z0-9_]+\]/.exec(code);
      if (fromPair && !declared.has(fromPair[1])) declared.set(fromPair[1], i);
      // 同一行可能声明多个 const，逐个记录（如 `const a = 1, b = 2`）
      for (const m of code.matchAll(/const\s+([A-Za-z0-9_]+)\s*=/g)) {
        if (!declared.has(m[1])) declared.set(m[1], i);
      }
    }

    for (let i = start; i < end; i += 1) {
      const code = stripNoise(lines[i]);
      for (const [name, declLine] of declared) {
        if (declLine <= i) continue;
        if (new RegExp(`\\b${name}\\b`).test(code)) {
          problems.push(`${componentStarts[c].name}: line ${i + 1} reads '${name}' declared at line ${declLine + 1}`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], `发现 const 前置引用（会导致 TDZ 崩溃）:\n${problems.join("\n")}`);
});
