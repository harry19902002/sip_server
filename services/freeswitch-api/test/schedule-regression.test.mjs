import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScheduleStore } from "../lib/schedule-store.mjs";
import { ScheduleService } from "../lib/schedule-service.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sip-schedules-"));
  return { directory, file: join(directory, "schedules.json") };
}

const input = { name: "晨间广播", mediaFileId: "media-1", zoneIds: ["zone-1"], repeat: "ONCE", date: "2026-08-31", time: "09:00", volume: 75 };

function makeService(store, { media, zones } = {}) {
  const calls = [];
  const broadcasts = {
    async create(payload, options) { calls.push({ payload, options }); return { broadcast: { id: `broadcast-${calls.length}` } }; },
    get() { return null; },
    async cancel() {},
  };
  const service = new ScheduleService({
    store,
    media: media ?? {
      getFile: (id) => id === "media-1" ? { id, originalName: "test.wav", freeswitchPath: "/var/lib/freeswitch/storage/media/test.wav" } : null,
      getPlaylist: () => null,
    },
    zones: zones ?? { list: () => [{ id: "zone-1", name: "测试分区", terminalIds: ["8000@sip.local"] }] },
    broadcasts,
  });
  return { service, calls };
}

// ---------------------------------------------------------------- 启用/暂停回归

test("pausing a schedule still works after its media file was deleted", (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ScheduleStore(file, { clock: () => new Date("2026-08-30T00:00:00.000Z") });
  const plan = makeService(store).service.create(input);

  // 媒体库清理后，只剩空 media
  const { service } = makeService(store, { media: { getFile: () => null, getPlaylist: () => null } });
  assert.equal(service.update(plan.id, { enabled: false }).enabled, false, "媒体缺失时仍应能暂停");
});

test("pausing a schedule still works after its zone was deleted", (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ScheduleStore(file, { clock: () => new Date("2026-08-30T00:00:00.000Z") });
  const plan = makeService(store).service.create(input);

  const { service } = makeService(store, { zones: { list: () => [] } });
  assert.equal(service.update(plan.id, { enabled: false }).enabled, false, "分区缺失时仍应能暂停");
});

test("editing play content still validates the sources", (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ScheduleStore(file, { clock: () => new Date("2026-08-30T00:00:00.000Z") });
  const plan = makeService(store).service.create(input);
  const { service } = makeService(store, { media: { getFile: () => null, getPlaylist: () => null } });
  // 改内容（不只是切换启用）时，音源不存在必须继续报错——不能因为放宽暂停而放弃校验
  assert.throws(() => service.update(plan.id, { volume: 30 }), /音频文件不存在|播放内容/);
});

test("re-enabling an expired one-off schedule fails loudly instead of silently never running", (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date("2026-08-30T00:00:00.000Z");
  const store = new ScheduleStore(file, { clock: () => now });
  const { service } = makeService(store);
  const plan = service.create(input);

  // 走完一次执行：ONCE 计划会转为 enabled=false 且清空 nextRunAt
  now = new Date("2026-08-31T01:00:05.000Z");
  store.complete(plan.id, { broadcastId: "broadcast-1" });
  assert.equal(store.get(plan.id).enabled, false);
  assert.equal(store.get(plan.id).nextRunAt, null);

  // 用户在列表里点亮开关想再跑一次 —— 此时执行时刻已过，算不出下次时间
  assert.throws(() => service.update(plan.id, { enabled: true }), /执行时间已过/);

  // 关键：不能留下 enabled=true 却 nextRunAt=null 的僵尸计划
  const stored = store.get(plan.id);
  assert.equal(stored.enabled, false);
  assert.equal(stored.nextRunAt, null);
});

test("re-enabling a recurring schedule still computes the next run", (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date("2026-08-30T00:00:00.000Z");
  const store = new ScheduleStore(file, { clock: () => now });
  const { service } = makeService(store);
  const plan = service.create({ ...input, repeat: "DAILY" });
  service.update(plan.id, { enabled: false });
  now = new Date("2026-09-05T00:00:00.000Z");
  const resumed = service.update(plan.id, { enabled: true });
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.nextRunAt, "2026-09-05T01:00:00.000Z");
});

// ---------------------------------------------------------------- 随机播放时长

test("SHUFFLE with a duration loops until stopped instead of playing once", async (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date("2026-08-30T00:00:00.000Z");
  const store = new ScheduleStore(file, { clock: () => now });
  const { service, calls } = makeService(store);
  service.create({ ...input, date: "2026-08-30", time: "09:00", playMode: "SHUFFLE", durationMinutes: 15 });

  now = new Date("2026-08-30T01:00:01.000Z");
  await service.runDue(now);

  assert.equal(calls.length, 1);
  // 随机模式必须要求持续播放，否则「15 分钟」形同虚设
  assert.equal(calls[0].payload.loop, true);
  assert.equal(calls[0].payload.playMode, "SHUFFLE");
  assert.ok(service.pendingStops.has("broadcast-1"), "应排定到时自动停止");
  service.cancelPendingStop("broadcast-1");
});

test("ONCE never requests looping", async (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date("2026-08-30T00:00:00.000Z");
  const store = new ScheduleStore(file, { clock: () => now });
  const { service, calls } = makeService(store);
  service.create({ ...input, date: "2026-08-30", time: "09:00", playMode: "ONCE" });
  now = new Date("2026-08-30T01:00:01.000Z");
  await service.runDue(now);
  assert.equal(calls[0].payload.loop, false);
});

test("missed occurrences during downtime are caught up on restart", async (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date("2026-08-30T00:00:00.000Z");
  const store = new ScheduleStore(file, { clock: () => now });
  const { service, calls } = makeService(store);
  const plan = service.create({ ...input, repeat: "DAILY" });

  // 停机到次日 12:00 才启动，错过了 09:00
  now = new Date("2026-08-31T04:00:00.000Z");
  await service.runDue(now);
  assert.equal(calls.length, 1, "错过的执行应补上");
  assert.equal(store.get(plan.id).nextRunAt, "2026-09-01T01:00:00.000Z");
});

test("concurrent ticks do not dispatch the same plan twice", async (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date("2026-08-30T00:00:00.000Z");
  const store = new ScheduleStore(file, { clock: () => now });
  store.create({ ...input, repeat: "DAILY" });
  now = new Date("2026-08-31T01:00:05.000Z");

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const service = new ScheduleService({
    store,
    media: { getFile: () => ({ id: "media-1", originalName: "t.wav", freeswitchPath: "/var/lib/freeswitch/storage/media/t.wav" }), getPlaylist: () => null },
    zones: { list: () => [{ id: "zone-1", name: "测试分区", terminalIds: ["8000@sip.local"] }] },
    broadcasts: { async create(p) { calls.push(p); await gate; return { broadcast: { id: "b" } }; }, get: () => null, async cancel() {} },
  });

  const first = service.runDue(now);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = service.runDue(now);
  release();
  await Promise.all([first, second]);
  assert.equal(calls.length, 1, "并发 tick 不应重复下发");
});
