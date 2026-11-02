/**
 * 用 CDP 驱动 Chrome：注入登录 cookie → 打开页面 → 截图。
 *
 * 前端会话是 HttpOnly cookie，普通脚本写不了，必须走 CDP 的
 * Network.setCookie。顺带可以执行 JS 来点菜单、验证折叠行为。
 *
 * 用法：
 *   node scripts/cdp-screenshot.mjs <url> <输出png> [--cookie name=value] [--click selector] [--eval js]
 */

const CDP_BASE = "http://127.0.0.1:9222";

async function getTarget() {
  const res = await fetch(`${CDP_BASE}/json/list`);
  const list = await res.json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("找不到可用的 page target");
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", reject);
  });
}

let nextId = 1;
function send(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const args = process.argv.slice(2);
const url = args[0];
const outPath = args[1];
const cookieArg = args.includes("--cookie") ? args[args.indexOf("--cookie") + 1] : null;
const clickSel = args.includes("--click") ? args[args.indexOf("--click") + 1] : null;
const evalJs = args.includes("--eval") ? args[args.indexOf("--eval") + 1] : null;

const target = await getTarget();
const ws = await connect(target.webSocketDebuggerUrl);

await send(ws, "Page.enable");
await send(ws, "Network.enable");
await send(ws, "Emulation.setDeviceMetricsOverride", {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

if (cookieArg) {
  const eq = cookieArg.indexOf("=");
  const name = cookieArg.slice(0, eq);
  const value = cookieArg.slice(eq + 1);
  await send(ws, "Network.setCookie", {
    name,
    value,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
  console.log(`已注入 cookie: ${name}`);
}

await send(ws, "Page.navigate", { url });
// 等应用完成水合与首屏数据请求
await new Promise((r) => setTimeout(r, 4000));

if (clickSel) {
  const result = await send(ws, "Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(clickSel)}); if (!el) return "NOT_FOUND"; el.click(); return "CLICKED"; })()`,
    returnByValue: true,
  });
  console.log(`点击 ${clickSel}: ${result.result.value}`);
  await new Promise((r) => setTimeout(r, 600));
}

if (evalJs) {
  const result = await send(ws, "Runtime.evaluate", {
    expression: evalJs,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("eval 结果:", JSON.stringify(result.result.value));
}

const shot = await send(ws, "Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));
console.log(`截图已保存: ${outPath}`);

ws.close();
