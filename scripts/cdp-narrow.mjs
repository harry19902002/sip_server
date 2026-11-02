/**
 * 在窄视口下截图，验证小屏底部导航。
 * 复用 cdp-screenshot 的逻辑，但先设置移动端视口尺寸。
 */

const CDP_BASE = "http://127.0.0.1:9222";

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

const [url, outPath, cookie, widthArg] = process.argv.slice(2);
const width = Number(widthArg || 600);

await send("Page.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height: 900,
  deviceScaleFactor: 1,
  mobile: width < 700,
});

if (cookie) {
  const eq = cookie.indexOf("=");
  await send("Network.setCookie", {
    name: cookie.slice(0, eq),
    value: cookie.slice(eq + 1),
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
}

await send("Page.navigate", { url });
await new Promise((r) => setTimeout(r, 4500));

const probe = await send("Runtime.evaluate", {
  expression: `(() => {
    const bar = document.getElementById ? null : null;
    const side = document.querySelector('.sidebar');
    const sideRect = side.getBoundingClientRect();
    const items = [...document.querySelectorAll('.nav-group-items > button')];
    const visible = items.filter(b => b.getBoundingClientRect().height > 0);
    const labels = visible.map(b => b.getAttribute('data-page'));
    const toggleVisible = [...document.querySelectorAll('.nav-group-toggle')].some(t => t.getBoundingClientRect().height > 0);
    return JSON.stringify({
      viewport: [innerWidth, innerHeight],
      sidebar: { w: Math.round(sideRect.width), h: Math.round(sideRect.height), bottom: Math.round(sideRect.bottom) },
      visibleNavItems: visible.length,
      visiblePages: labels,
      groupToggleVisible: toggleVisible,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    });
  })()`,
  returnByValue: true,
});
console.log("探测:", probe.result.value);

const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));
console.log("截图:", outPath);
ws.close();
