import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScheduleStore, nextRunAt } from "../lib/schedule-store.mjs";
import { ScheduleService } from "../lib/schedule-service.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sip-schedules-"));
  return { directory, file: join(directory, "schedules.json") };
}

const input = { name: "晨间广播", mediaFileId: "media-1", zoneIds: ["zone-1"], repeat: "ONCE", date: "2026-08-31", time: "09:00", volume: 75 };

test("persists, toggles, and deletes real schedules", (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const clock = () => new Date("2026-08-30T00:00:00.000Z");
  const store = new ScheduleStore(file, { clock });
  const plan = store.create(input);
  assert.equal(plan.nextRunAt, "2026-08-31T01:00:00.000Z");
  assert.equal(new ScheduleStore(file, { clock }).list().length, 1);
  assert.equal(store.update(plan.id, { enabled: false }).enabled, false);
  assert.equal(store.delete(plan.id).id, plan.id);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).schedules.length, 0);
});

test("calculates weekday and weekly occurrences in Asia/Shanghai", () => {
  const base = { ...input, date: "2026-08-29", time: "09:00" };
  assert.equal(nextRunAt({ ...base, repeat: "WEEKDAYS" }, new Date("2026-08-29T02:00:00Z")), "2026-08-31T01:00:00.000Z");
  assert.equal(nextRunAt({ ...base, repeat: "WEEKLY" }, new Date("2026-08-29T02:00:00Z")), "2026-09-05T01:00:00.000Z");
});

test("dispatches a due schedule through the broadcast service", async (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date("2026-08-30T00:00:00.000Z");
  const store = new ScheduleStore(file, { clock: () => now });
  const plan = store.create({ ...input, date: "2026-08-30", time: "09:00" });
  const calls = [];
  const broadcasts = {
    async create(payload, options) { calls.push({ payload, options }); return { broadcast: { id: "broadcast-1" } }; },
    get(id) { return id === "broadcast-1" ? { id, state: "QUEUED" } : null; },
  };
  const service = new ScheduleService({
    store,
    media: { getFile: (id) => id === "media-1" ? { id, freeswitchPath: "/var/lib/freeswitch/storage/media/test.wav" } : null },
    zones: { list: () => [{ id: "zone-1", name: "测试分区", terminalIds: ["8000@sip.local"] }] },
    broadcasts,
  });
  now = new Date("2026-08-30T01:00:01.000Z");
  await service.runDue(now);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].payload.targets, ["8000"]);
  assert.match(calls[0].options.idempotencyKey, new RegExp(plan.id));
  assert.equal(store.get(plan.id).lastBroadcastId, "broadcast-1");
  assert.equal(store.get(plan.id).enabled, false);
});

// ---------------------------------------------------------------- 播放模式

test("defaults schedules to ONCE play mode with no duration", () => {
  const { directory, file } = fixture();
  const store = new ScheduleStore(file, { clock: () => new Date("2026-08-30T00:00:00.000Z") });
  const plan = store.create(input);
  assert.equal(plan.playMode, "ONCE");
  assert.equal(plan.durationMinutes, 0);
});

test("accepts LOOP/SHUFFLE with a valid duration and rejects invalid ones", () => {
  const { directory, file } = fixture();
  const store = new ScheduleStore(file, { clock: () => new Date("2026-08-30T00:00:00.000Z") });

  const looped = store.create({ ...input, playMode: "LOOP", durationMinutes: 30 });
  assert.equal(looped.playMode, "LOOP");
  assert.equal(looped.durationMinutes, 30);

  // 0 表示一直播放，是合法值
  const endless = store.create({ ...input, playMode: "SHUFFLE", durationMinutes: 0 });
  assert.equal(endless.durationMinutes, 0);

  assert.throws(() => store.create({ ...input, playMode: "SHUFFLE", durationMinutes: -1 }), /durationMinutes/);
  assert.throws(() => store.create({ ...input, playMode: "LOOP", durationMinutes: 1.5 }), /durationMinutes/);
  assert.throws(() => store.create({ ...input, playMode: "LOOP", durationMinutes: 24 * 60 + 1 }), /durationMinutes/);
  assert.throws(() => store.create({ ...input, playMode: "BOGUS" }), /playMode/);
});

test("ignores duration for ONCE mode", () => {
  const { directory, file } = fixture();
  const store = new ScheduleStore(file, { clock: () => new Date("2026-08-30T00:00:00.000Z") });
  // 单次播放按音频自身长度播完即止，时长字段无意义，归一化为 0
  const plan = store.create({ ...input, playMode: "ONCE", durationMinutes: 45 });
  assert.equal(plan.durationMinutes, 0);
});

test("persists multiple ordered play sources", (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new ScheduleStore(file, { clock: () => new Date("2026-08-30T00:00:00.000Z") });
  const sourceItems = [
    { type: "PLAYLIST", id: "playlist-1" },
    { type: "FILE", id: "media-2" },
  ];
  const plan = store.create({ ...input, mediaFileId: "", sourceItems });
  assert.deepEqual(plan.sourceItems, sourceItems);
  // 未提供 mediaFileId 时也应能创建（音源全部由 sourceItems 提供）
  assert.equal(plan.mediaFileId, "");
});

test("rejects a schedule without any play source", () => {
  const { directory, file } = fixture();
  const store = new ScheduleStore(file, { clock: () => new Date("2026-08-30T00:00:00.000Z") });
  assert.throws(() => store.create({ ...input, mediaFileId: "" }), /play source/i);
});

test("expands sources, passes playMode, and schedules an auto-stop for LOOP", async (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date("2026-08-30T00:00:00.000Z");
  const store = new ScheduleStore(file, { clock: () => now });
  const plan = store.create({
    ...input,
    date: "2026-08-30",
    time: "09:00",
    mediaFileId: "",
    sourceItems: [{ type: "PLAYLIST", id: "playlist-1" }],
    playMode: "LOOP",
    durationMinutes: 20,
  });

  const calls = [];
  const canceled = [];
  const broadcasts = {
    async create(payload) { calls.push(payload); return { broadcast: { id: "broadcast-9" } }; },
    get() { return null; },
    async cancel(id) { canceled.push(id); },
  };
  const service = new ScheduleService({
    store,
    media: {
      getFile: () => null,
      getPlaylist: (id) => id === "playlist-1"
        ? { id, name: "晨间列表", files: [{ freeswitchPath: "/var/lib/freeswitch/storage/media/a.wav" }, { freeswitchPath: "/var/lib/freeswitch/storage/media/b.wav" }] }
        : null,
    },
    zones: { list: () => [{ id: "zone-1", name: "测试分区", terminalIds: ["8000@sip.local"] }] },
    broadcasts,
  });

  now = new Date("2026-08-30T01:00:01.000Z");
  await service.runDue(now);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].playMode, "LOOP");
  assert.equal(calls[0].sourceType, "PLAYLIST");
  assert.match(calls[0].audio, /file_string:\/\/.*a\.wav!.*b\.wav/);

  // 循环 + 20 分钟 → 应排定了自动停止
  assert.ok(service.pendingStops.has("broadcast-9"), "expected a pending auto-stop for LOOP");
  service.cancelPendingStop("broadcast-9");
  assert.equal(service.pendingStops.size, 0);
});

test("does not schedule an auto-stop when duration is 0", async (t) => {
  const { directory, file } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = new Date("2026-08-30T00:00:00.000Z");
  const store = new ScheduleStore(file, { clock: () => now });
  store.create({
    ...input,
    date: "2026-08-30",
    time: "09:00",
    playMode: "SHUFFLE",
    durationMinutes: 0,
  });
  const broadcasts = { async create() { return { broadcast: { id: "broadcast-10" } }; }, get() { return null; }, async cancel() {} };
  const service = new ScheduleService({
    store,
    media: { getFile: (id) => ({ id, freeswitchPath: "/var/lib/freeswitch/storage/media/test.wav" }) },
    zones: { list: () => [{ id: "zone-1", name: "测试分区", terminalIds: ["8000@sip.local"] }] },
    broadcasts,
  });
  now = new Date("2026-08-30T01:00:01.000Z");
  await service.runDue(now);
  // 时长为 0 = 一直播放，不应排定停止
  assert.equal(service.pendingStops.size, 0);
});
