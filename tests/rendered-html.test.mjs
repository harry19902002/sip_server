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
