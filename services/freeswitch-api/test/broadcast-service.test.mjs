import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BroadcastService, volumeToLevel } from "../lib/broadcast-service.mjs";
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

test("maps the 0-100 volume percentage onto the FreeSWITCH -4..4 scale", () => {
  // 50% 必须是 0：freeSWITCH 的 level 0 等于不做任何增益，是唯一的安全中性点。
  assert.equal(volumeToLevel(50), 0);
  assert.equal(volumeToLevel(0), -4);
  assert.equal(volumeToLevel(100), 4);
  // 越界与非法输入被夹紧，绝不下发会被 FreeSWITCH 静默丢弃的值。
  assert.equal(volumeToLevel(-20), -4);
  assert.equal(volumeToLevel(999), 4);
  assert.ok(volumeToLevel(Number.NaN) >= -4 && volumeToLevel(Number.NaN) <= 4);
  for (let percent = 0; percent <= 100; percent += 1) {
    const level = volumeToLevel(percent);
    assert.ok(Number.isInteger(level) && level >= -4 && level <= 4, `volume ${percent} produced invalid level ${level}`);
  }
});

test("does not send the non-existent playback_volume variable when dialing", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await service.create({ ...validInput, targets: ["1000"] });
  // playback_volume 在 FreeSWITCH 源码中不存在任何引用，属于无效变量；
  // 一旦回归，音量会再次变成静默失效的假功能。
  assert.doesNotMatch(commands[0], /playback_volume/);
});

test("applies the stored volume to the channel once it answers", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"], volume: 100 });
  const target = broadcast.targets[0];

  service.handleEvent({
    "Event-Name": "CHANNEL_ANSWER",
    "Unique-ID": target.channelUuid,
    variable_sip_broadcast_id: broadcast.id,
    variable_sip_target_id: target.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const volumeCommand = commands.find((command) => command.startsWith("uuid_audio "));
  assert.ok(volumeCommand, "no uuid_audio command was issued on answer");
  // 100% → +4，写方向（广播是往终端写音频）。
  assert.match(volumeCommand, /^uuid_audio .+ start write level 4$/);
});

test("setVolume writes back the record and pushes the level to live channels", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { broadcast } = await service.create({ ...validInput, targets: ["1000", "1001"] });

  const result = await service.setVolume(broadcast.id, 0);
  assert.equal(result.broadcast.volume, 0);
  // 两个目标都还没有应答，但都已经拿到 channelUuid，因此都应收到指令。
  assert.equal(result.attempted, 2);
  assert.equal(result.applied, 2);
  const volumeCommands = commands.filter((command) => command.startsWith("uuid_audio "));
  assert.equal(volumeCommands.length, 2);
  volumeCommands.forEach((command) => assert.match(command, / start write level -4$/));
});

test("setVolume rejects out-of-range input and finished tasks", async (t) => {
  const { directory, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"] });

  await assert.rejects(service.setVolume(broadcast.id, 101), /volume must be an integer from 0 to 100/);
  await assert.rejects(service.setVolume(broadcast.id, 12.5), /volume must be an integer from 0 to 100/);
  await assert.rejects(service.setVolume("missing-id", 50), /broadcast not found/);

  await service.cancel(broadcast.id);
  // 已结束的任务不允许再调音量，应提示重发。
  await assert.rejects(service.setVolume(broadcast.id, 30), /已结束的任务不能调整音量/);
});

test("replays a finished broadcast with the original content and volume", async (t) => {
  const { directory, commands, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const audio = "file_string:///var/lib/freeswitch/storage/media/first.wav";
  const { broadcast } = await service.create({
    ...validInput, targets: ["1000"], audio, volume: 20, playMode: "LOOP",
    sourceType: "PLAYLIST", sourceId: "playlist-1", sourceName: "晨间列表",
  });
  await service.cancel(broadcast.id);

  const before = commands.length;
  const replayed = await service.replay(broadcast.id);
  const repeat = replayed.broadcast;

  assert.notEqual(repeat.id, broadcast.id, "replay must create a new record");
  assert.equal(repeat.name, broadcast.name);
  assert.equal(repeat.audio, audio);
  assert.equal(repeat.volume, 20);
  assert.equal(repeat.playMode, "LOOP");
  assert.equal(repeat.sourceType, "PLAYLIST");
  assert.equal(repeat.sourceName, "晨间列表");
  assert.equal(repeat.replayOfId, broadcast.id);
  assert.deepEqual(repeat.targets.map((target) => target.extension), ["1000"]);
  // 原任务保持不可变，便于审计。
  const original = service.get(broadcast.id);
  assert.equal(original.state, "CANCELED");
  assert.equal(original.replayOfId, null);
  assert.match(commands[before], /endless_playback\(/);
});

test("replay refuses tasks that are still running", async (t) => {
  const { directory, service } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { broadcast } = await service.create({ ...validInput, targets: ["1000"] });
  await assert.rejects(service.replay(broadcast.id), /该任务尚未结束/);
  await assert.rejects(service.replay("missing-id"), /broadcast not found/);
});

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
