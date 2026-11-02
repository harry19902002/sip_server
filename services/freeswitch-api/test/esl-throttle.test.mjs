import assert from "node:assert/strict";
import test from "node:test";
import { EslEventSubscriber } from "../lib/esl-client.mjs";

// ESL 断连播报节流：修复前每 2 秒重连一次、单次失败还会因
// error/close/catch 三处回调重复播报，实测把 api.log 刷了 4582 行。
// 这里直接驱动 reportState，验证「状态变化才播报」的语义。

function collector() {
  const reports = [];
  const subscriber = new EslEventSubscriber({ host: "127.0.0.1", password: "x" });
  subscriber.onState = (state) => reports.push(state);
  return { reports, subscriber };
}

test("reports the first disconnect immediately", () => {
  const { reports, subscriber } = collector();
  subscriber.reportState({ connected: false, error: "connect ECONNREFUSED 127.0.0.1:8021" });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].connected, false);
});

test("does not repeat the same disconnected state", () => {
  const { reports, subscriber } = collector();
  for (let index = 0; index < 100; index += 1) {
    subscriber.reportState({ connected: false, error: "connect ECONNREFUSED 127.0.0.1:8021" });
  }
  // 100 次连续失败只应播报 1 次（修复前会播报 100 次甚至更多）
  assert.equal(reports.length, 1, `expected 1 report, got ${reports.length}`);
});

test("does not repeat the same connected state either", () => {
  const { reports, subscriber } = collector();
  subscriber.reportState({ connected: true });
  subscriber.reportState({ connected: true });
  subscriber.reportState({ connected: true });
  assert.equal(reports.length, 1);
});

test("reports again when the state actually flips back and forth", () => {
  const { reports, subscriber } = collector();
  subscriber.reportState({ connected: true });
  subscriber.reportState({ connected: false, error: "read ECONNRESET" });
  subscriber.reportState({ connected: true });
  subscriber.reportState({ connected: false, error: "read ECONNRESET" });
  // 每次真实变化都应上报：连→断→连→断 = 4 次
  assert.equal(reports.length, 4);
  assert.deepEqual(reports.map((item) => item.connected), [true, false, true, false]);
});

test("re-emits a reminder once the interval elapses while still down", () => {
  const { reports, subscriber } = collector();
  subscriber.reportState({ connected: false, error: "down" });
  assert.equal(reports.length, 1);
  // 把上次播报时间往前拨，模拟已过去超过提醒间隔
  subscriber.lastReportAt = Date.now() - 61_000;
  subscriber.reportState({ connected: false, error: "down" });
  assert.equal(reports.length, 2, "持续断开时应按间隔补发提醒");
  assert.equal(reports[1].reminder, true);
});

test("resets the attempt counter once reconnected", () => {
  const { subscriber } = collector();
  subscriber.attempts = 7;
  subscriber.reportState({ connected: true });
  assert.equal(subscriber.attempts, 0);
});
