import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PresetStore } from "../lib/preset-store.mjs";
import { PresetService } from "../lib/preset-service.mjs";
import { BroadcastStore } from "../lib/broadcast-store.mjs";
import { BroadcastService } from "../lib/broadcast-service.mjs";

const input = { name: "安全提示", zoneIds: ["zone-1"], sources: [{ type: "FILE", id: "file-1" }], volume: 60, playMode: "LOOP" };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "sip-preset-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const commands = [];
  const esl = { execute: async (command) => { commands.push(command); return { body: "true", jobUuid: randomUUID() }; } };
  const broadcasts = new BroadcastService({ store: new BroadcastStore(join(directory, "broadcasts.json")), esl, domain: "sip.local" });
  const files = [{ id: "file-1", originalName: "提示.wav", freeswitchPath: "/var/lib/freeswitch/storage/media/first.wav" },
    { id: "file-2", originalName: "通知.mp3", freeswitchPath: "/var/lib/freeswitch/storage/media/second.mp3" }];
  const media = { getFile: (id) => files.find((file) => file.id === id), getPlaylist: () => ({ name: "播放列表", files }) };
  const zoneList = [{ id: "zone-1", name: "教学区", terminalIds: ["1000@sip.local", "1001@sip.local"] }];
  const zones = { list: () => zoneList };
  const store = new PresetStore(join(directory, "presets.json"));
  const service = new PresetService({ store, media, zones, broadcasts, esl });
  return { directory, commands, esl, broadcasts, files, zoneList, store, service, media, zones };
}
function park(preset, uuid = randomUUID()) {
  return { "Event-Name": "CHANNEL_PARK", "Unique-ID": uuid, variable_sip_preset_number: preset.sipNumber, variable_sip_auth_username: "1005" };
}

test("allocates persistent, immutable, non-recycled SIP numbers", (t) => {
  const { directory, store, service } = fixture(t);
  const first = service.create(input);
  assert.equal(first.sipNumber, "880001");
  assert.equal(service.update(first.id, { name: "新的名称", sipNumber: "880999" }).sipNumber, first.sipNumber);
  service.delete(first.id);
  const reloaded = new PresetStore(join(directory, "presets.json"), { numberAvailable: (number) => number !== "880002" });
  assert.equal(reloaded.create(input).sipNumber, "880003");
  assert.equal(store.list().length, 0);
});
test("resolves the current zone members and ordered mixed playlist contents", async (t) => {
  const { service, zoneList, commands } = fixture(t);
  const preset = service.create({ ...input, sources: [{ type: "PLAYLIST", id: "playlist-1" }, { type: "FILE", id: "file-1" }] });
  zoneList[0].terminalIds = ["1002@sip.local"];
  const running = await service.start(preset.id);
  assert.equal(running.broadcast.type, "PRESET");
  assert.equal(running.broadcast.presetId, preset.id);
  assert.deepEqual(running.broadcast.targets.map((target) => target.extension), ["1002"]);
  assert.equal(running.active, true);
  assert.match(commands[0], /&endless_playback\(file_string:\/\/.*first\.wav!.*second\.mp3!.*first\.wav\)/);
  await service.stop(preset.id);
  assert.equal(service.get(preset.id).active, false);
  assert.equal(commands.filter((command) => command.startsWith("uuid_kill")).length, 1);
  await service.stop(preset.id);
});
test("rejects concurrent starts and editing or deleting running presets", async (t) => {
  const { service } = fixture(t);
  const preset = service.create(input);
  const first = service.start(preset.id);
  await assert.rejects(service.start(preset.id), { status: 409 });
  assert.throws(() => service.update(preset.id, { name: "修改" }), { status: 409 });
  assert.throws(() => service.delete(preset.id), { status: 409 });
  await first; await service.stop(preset.id);
  assert.equal(service.update(preset.id, { name: "修改" }).name, "修改");
});
test("an authenticated SIP call starts a preset and caller hangup stops all targets", async (t) => {
  const { service, commands } = fixture(t);
  const preset = service.create(input);
  const event = park(preset);
  await service.handleEvent(event);
  assert.equal(service.get(preset.id).trigger, "SIP");
  const busy = park(preset);
  await service.handleEvent(busy);
  assert.ok(commands.includes(`uuid_kill ${busy["Unique-ID"]} USER_BUSY`));
  await service.handleEvent({ "Event-Name": "CHANNEL_HANGUP_COMPLETE", "Unique-ID": event["Unique-ID"] });
  assert.equal(service.get(preset.id).active, false);
  assert.equal(commands.filter((command) => command.startsWith("uuid_kill") && command.endsWith("NORMAL_CLEARING")).length, 3);
});
test("caller hangup during dispatch cancels channels once their UUIDs become available", async (t) => {
  const { service, esl } = fixture(t);
  const preset = service.create(input);
  const original = esl.execute;
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  esl.execute = async (command) => { if (command.startsWith("originate")) await gate; return original(command); };
  const event = park(preset);
  const starting = service.handleEvent(event);
  const stopping = service.handleEvent({ "Event-Name": "CHANNEL_HANGUP_COMPLETE", "Unique-ID": event["Unique-ID"] });
  resume(); await Promise.all([starting, stopping]);
  assert.equal(service.get(preset.id).active, false);
  const task = service.broadcasts.list()[0];
  assert.equal(task.state, "CANCELED");
  assert.ok(task.targets.every((target) => target.state === "CANCELED"));
});

test("a failed web stop is retained and retried after ESL recovers", async (t) => {
  const { service, esl } = fixture(t);
  const preset = service.create(input); await service.start(preset.id);
  const original = esl.execute;
  esl.execute = async () => { throw new Error("ESL unavailable"); };
  await assert.rejects(service.stop(preset.id), /unavailable/);
  assert.equal(service.get(preset.id).active, true);
  esl.execute = original; await service.reconcile();
  assert.equal(service.get(preset.id).active, false);
  assert.equal(service.get(preset.id).broadcast.state, "CANCELED");
});
test("unauthenticated or unassigned calls cannot launch a broadcast", async (t) => {
  const { service, commands } = fixture(t);
  const preset = service.create(input);
  const event = { ...park(preset), variable_sip_auth_username: "" };
  await service.handleEvent(event);
  await service.handleEvent({ ...park(preset), variable_sip_preset_number: "889999" });
  assert.equal(service.broadcasts.list().length, 0);
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => command.endsWith("CALL_REJECTED")));
});
test("missing media rejects SIP initiation and releases the controller", async (t) => {
  const { service, files, commands } = fixture(t);
  const preset = service.create(input); files.length = 0;
  const event = park(preset);
  await assert.rejects(service.handleEvent(event), /音频已不存在/);
  assert.ok(commands.includes(`uuid_kill ${event["Unique-ID"]} CALL_REJECTED`));
  assert.equal(service.get(preset.id).active, false);
});
test("natural completion hangs up the SIP controller and allows replay", async (t) => {
  const { service, broadcasts, commands } = fixture(t);
  const preset = service.create({ ...input, playMode: "ONCE" });
  const event = park(preset); await service.handleEvent(event);
  const task = service.get(preset.id).broadcast;
  for (const target of task.targets) {
    broadcasts.handleEvent({ "Event-Name": "CHANNEL_ANSWER", variable_sip_broadcast_id: task.id, variable_sip_target_id: target.id });
    const hangup = { "Event-Name": "CHANNEL_HANGUP_COMPLETE", "Hangup-Cause": "NORMAL_CLEARING", variable_sip_broadcast_id: task.id, variable_sip_target_id: target.id };
    broadcasts.handleEvent(hangup); await service.handleEvent(hangup);
  }
  assert.equal(service.get(preset.id).active, false);
  assert.ok(commands.includes(`uuid_kill ${event["Unique-ID"]} NORMAL_CLEARING`));
  await service.start(preset.id);
});
test("after API restart reconciliation cancels a task whose controller has disappeared", async (t) => {
  const { service, store, media, zones, broadcasts, esl } = fixture(t);
  const preset = service.create(input); await service.handleEvent(park(preset));
  const recovered = new PresetService({ store, media, zones, broadcasts, esl });
  esl.execute = async () => ({ body: "false" });
  await recovered.reconcile();
  assert.equal(recovered.get(preset.id).active, false);
  assert.equal(broadcasts.list()[0].state, "CANCELED");
});
test("rejects invalid sources, modes, volume, zones and oversized playlists", (t) => {
  const { service, files } = fixture(t);
  for (const invalid of [{ sources: [] }, { sources: [{ type: "COMMAND", id: "cmd" }] }, { volume: -1 }, { playMode: "BAD" }, { zoneIds: ["deleted"] }]) {
    assert.throws(() => service.create({ ...input, ...invalid }));
  }
  files.push(...Array.from({ length: 100 }, () => files[0]));
  assert.throws(() => service.create({ ...input, sources: [{ type: "PLAYLIST", id: "playlist-1" }] }), /100/);
});
