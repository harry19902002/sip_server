/**
 * 二级菜单的回归验收：在三种视口下检查关键行为。
 *
 * 用法：node scripts/verify-nav.mjs <url> <cookie值> [cdp端口]
 */

const CDP_PORT = process.argv[4] || "9224";
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;

const url = process.argv[2];
const cookieValue = process.argv[3];

const list = await (await fetch(`${CDP_BASE}/json/list`)).json();
const page = list.find((t) => t.type === "page");
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

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
};

await send("Page.enable");
await send("Network.enable");
await send("Network.setCookie", {
  name: "sip_session",
  value: cookieValue,
  domain: "127.0.0.1",
  path: "/",
  httpOnly: true,
  sameSite: "Lax",
});

const report = [];

for (const [label, width] of [["宽屏 1600", 1600], ["中屏 1100", 1100], ["窄屏 600", 600]]) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: width < 700,
  });
  await send("Page.navigate", { url });
  await new Promise((r) => setTimeout(r, 4500));

  const state = await evalJs(`(() => {
    const groups = [...document.querySelectorAll('.nav-group')];
    const toggles = [...document.querySelectorAll('.nav-group-toggle')];
    const items = [...document.querySelectorAll('.nav-group-items > button')];
    const visibleItems = items.filter(b => b.getBoundingClientRect().height > 0);
    const firstToggle = toggles[0];
    const cs = firstToggle ? getComputedStyle(firstToggle) : null;
    return JSON.stringify({
      groups: groups.length,
      toggles: toggles.length,
      items: items.length,
      visibleItems: visibleItems.length,
      visiblePages: visibleItems.map(b => b.getAttribute('data-page')),
      toggleHeight: cs ? cs.height : null,
      toggleCursor: cs ? cs.cursor : null,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      stored: localStorage.getItem('sip-nav-groups'),
    });
  })()`);
  report.push({ viewport: label, ...JSON.parse(state) });
}

console.log(JSON.stringify(report, null, 2));
ws.close();
