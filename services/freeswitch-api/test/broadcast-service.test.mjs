import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BroadcastService } from "../lib/broadcast-service.mjs";
import { BroadcastStore } from "../lib/broadcast-store.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sip-broadcast-test-"));
  let job = 0;
  const commands = [];
  const esl = {
    async execute(command) {
      commands.push(command);
      return { body: "+OK", jobUuid: `job-${++job}` };
    },
  };
  const store = new BroadcastStore(join(directory, "broadcasts.json"));
  const service = new BroadcastService({ store, esl, domain: "sip.local" });
  return { directory, commands, service };
}

const validInput = {
  name: "安全提示",
  targets: ["1000", "1001"],
  audio: "tone_stream://%(2000,0,440)",
  callerId: "9999",
  volume: 75,
};

test("creates and persists an idempotent broadcast with target jobs", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const first = await service.create(validInput, { idempotencyKey: "request-1" });
  const replay = await service.create(validInput, { idempotencyKey: "request-1" });

  assert.equal(first.replayed, false);
  assert.equal(first.broadcast.state, "RUNNING");
  assert.equal(first.broadcast.targets.length, 2);
  assert.deepEqual(first.broadcast.targets.map((target) => target.state), ["QUEUED", "QUEUED"]);
  assert.equal(commands.length, 2);
  assert.equal(replay.replayed, true);
  assert.equal(replay.broadcast.id, first.broadcast.id);
  assert.equal(commands.length, 2);
});

test("maps answer and hangup events to a successful terminal state", async (t) => {
  const { directory, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"] });
  const target = broadcast.targets[0];

  service.handleEvent({
    "Event-Name": "CHANNEL_ANSWER",
    variable_sip_broadcast_id: broadcast.id,
    variable_sip_target_id: target.id,
  });
  service.handleEvent({
    "Event-Name": "CHANNEL_HANGUP_COMPLETE",
    "Hangup-Cause": "NORMAL_CLEARING",
    variable_sip_broadcast_id: broadcast.id,
    variable_sip_target_id: target.id,
  });

  const completed = service.get(broadcast.id);
  assert.equal(completed.state, "SUCCEEDED");
  assert.equal(completed.targets[0].state, "SUCCEEDED");
  assert.ok(completed.finishedAt);
});

test("cancels active channels and makes cancellation idempotent", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"] });

  const canceled = await service.cancel(broadcast.id);
  const repeated = await service.cancel(broadcast.id);

  assert.equal(canceled.state, "CANCELED");
  assert.equal(canceled.targets[0].state, "CANCELED");
  assert.match(commands.at(-1), /^uuid_kill /);
  assert.equal(repeated.state, "CANCELED");
});

test("rejects unsafe media commands", async (t) => {
  const { directory, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(
    service.create({ ...validInput, audio: "tone_stream://x) &system(rm)" }),
    /audio must be an approved/,
  );
});

test("plays an approved ordered media playlist", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const audio = "file_string:///var/lib/freeswitch/storage/media/first.wav!/var/lib/freeswitch/storage/media/second.mp3";
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"], audio, sourceType: "PLAYLIST", sourceId: "playlist-1", sourceName: "晨间列表" });
  assert.equal(broadcast.sourceType, "PLAYLIST");
  assert.equal(broadcast.sourceName, "晨间列表");
  assert.match(commands[0], /playback\(file_string:\/\//);
  await assert.rejects(service.create({ ...validInput, audio: "file_string:///tmp/bad.wav!/var/lib/freeswitch/storage/media/good.wav" }), /approved WAV\/MP3/);
});

test("persists a mixed ordered media queue", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceItems = [
    { type: "PLAYLIST", id: "playlist-1", name: "晨间列表", fileCount: 2 },
    { type: "FILE", id: "file-3", name: "临时通知.wav", fileCount: 1 },
  ];
  const audio = "file_string:///var/lib/freeswitch/storage/media/first.wav!/var/lib/freeswitch/storage/media/second.mp3!/var/lib/freeswitch/storage/media/notice.wav";
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"], audio, sourceType: "MIXED", sourceName: "晨间列表、临时通知.wav", sourceItems });
  assert.equal(broadcast.sourceType, "MIXED");
  assert.deepEqual(broadcast.sourceItems, sourceItems);
  assert.match(commands[0], /first\.wav!.*second\.mp3!.*notice\.wav/);
});

test("defaults to ONCE play mode and uses the playback application", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"] });
  assert.equal(broadcast.playMode, "ONCE");
  assert.match(commands[0], /&playback\(/);
  assert.doesNotMatch(commands[0], /endless_playback/);
});

test("uses endless_playback for LOOP mode", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const audio = "file_string:///var/lib/freeswitch/storage/media/first.wav!/var/lib/freeswitch/storage/media/second.mp3";
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"], audio, playMode: "LOOP" });
  assert.equal(broadcast.playMode, "LOOP");
  assert.match(commands[0], /&endless_playback\(file_string:\/\//);
});

test("late answer and hangup events do not revive a canceled preset task", async (t) => {
  const { directory, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"], presetId: "preset-1" });
  await service.cancel(broadcast.id);
  for (const name of ["CHANNEL_ANSWER", "CHANNEL_HANGUP_COMPLETE"]) service.handleEvent({
    "Event-Name": name, "Hangup-Cause": "NORMAL_CLEARING", variable_sip_broadcast_id: broadcast.id, variable_sip_target_id: broadcast.targets[0].id,
  });
  assert.equal(service.get(broadcast.id).state, "CANCELED");
  assert.equal(service.get(broadcast.id).targets[0].state, "CANCELED");
});

test("failed hangup remains cancel-requested and can be retried", async (t) => {
  const { directory, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"] });
  const original = service.esl.execute;
  service.esl.execute = async () => { throw new Error("ESL connection refused"); };
  await assert.rejects(service.cancel(broadcast.id), /connection refused/);
  assert.equal(service.get(broadcast.id).state, "CANCELED_REQUESTED");
  service.esl.execute = original;
  assert.equal((await service.cancel(broadcast.id)).state, "CANCELED");
});

test("normalizes unknown play modes to ONCE", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"], playMode: "bogus" });
  assert.equal(broadcast.playMode, "ONCE");
  assert.match(commands[0], /&playback\(/);
});

test("keeps the shuffled order for SHUFFLE mode", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const audio = "file_string:///var/lib/freeswitch/storage/media/b.wav!/var/lib/freeswitch/storage/media/a.wav";
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"], audio, playMode: "SHUFFLE" });
  assert.equal(broadcast.playMode, "SHUFFLE");
  assert.match(commands[0], /&playback\(file_string:\/\/.*b\.wav!.*a\.wav\)/);
});
