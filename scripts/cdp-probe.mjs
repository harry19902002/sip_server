/**
 * 在指定视口宽度下检查菜单分组头与菜单项的计算样式。
 * 用法：node scripts/cdp-probe.mjs <url> <width> <表达式文件或直接表达式>
 */

const CDP_BASE = "http://127.0.0.1:9222";

const [url, widthArg, expr] = process.argv.slice(2);
const width = Number(widthArg || 1600);

const list = await (await fetch(`${CDP_BASE}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("没有可用页面");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});

let id = 1;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = id++;
    const onMsg = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== myId) return;
      ws.removeEventListener("message", onMsg);
      if (m.error) reject(new Error(`${method}: ${m.error.message}`));
      else resolve(m.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

await send("Page.navigate", { url });
await new Promise((r) => setTimeout(r, 4000));

const result = await send("Runtime.evaluate", {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
});
console.log(JSON.stringify(result.result.value, null, 2));

ws.close();
