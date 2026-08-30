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
