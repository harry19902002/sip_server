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
