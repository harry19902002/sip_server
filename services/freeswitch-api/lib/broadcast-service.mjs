import { randomUUID } from "node:crypto";

const extensionPattern = /^[0-9]{2,12}$/;
const toneAudioPattern = /^tone_stream:\/\/%\([0-9]{1,5},[0-9]{1,5},[0-9]{2,5}\)$/;
const terminalTargetStates = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
// 播放模式：ONCE 单次播放、LOOP 循环播放、SHUFFLE 随机播放（顺序已在上游打乱）。
const playModes = new Set(["ONCE", "LOOP", "SHUFFLE"]);
// 循环播放使用 endless_playback，持续循环直到任务被取消或终端挂断；
// 其余模式使用 playback 顺序播放一次。
function playApplication(playMode) {
  return playMode === "LOOP" ? "endless_playback" : "playback";
}

// 允许的音频根目录。容器部署为 Linux 绝对路径；Windows 便携部署时
// 媒体目录位于便携包内，因此额外放行盘符路径。
const defaultAudioRoots = ["/usr/share/freeswitch/sounds", "/var/lib/freeswitch/storage", "/var/lib/freeswitch/recordings"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildAudioPattern(roots) {
  const alternatives = roots
    .map((root) => root.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter(Boolean)
    .map((root) => escapeRegExp(root));
  // Windows 盘符路径（如 C:/...）也纳入白名单
  alternatives.push("[A-Za-z]:");
  return new RegExp(`^(?:${alternatives.join("|")})/[a-zA-Z0-9_./ -]+\\.(?:wav|mp3)$`);
}

function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function approvedAudio(audio, pattern) {
  if (pattern.test(audio) || toneAudioPattern.test(audio)) return true;
  if (!audio.startsWith("file_string://")) return false;
  const files = audio.slice("file_string://".length).split("!");
  return files.length > 0 && files.length <= 100 && files.every((file) => pattern.test(file));
}

function aggregate(broadcast) {
  if (broadcast.state === "CANCELED" || broadcast.state === "CANCELED_REQUESTED") return;
  const states = broadcast.targets.map((target) => target.state);
  if (!states.every((state) => terminalTargetStates.has(state))) {
    broadcast.state = states.some((state) => ["ANSWERED", "PLAYING", "QUEUED"].includes(state)) ? "RUNNING" : broadcast.state;
    return;
  }
  const succeeded = states.filter((state) => state === "SUCCEEDED").length;
  broadcast.state = succeeded === states.length ? "SUCCEEDED" : succeeded > 0 ? "PARTIAL_FAILED" : states.every((state) => state === "CANCELED") ? "CANCELED" : "FAILED";
  broadcast.finishedAt = new Date().toISOString();
}

export class BroadcastService {
  constructor({ store, esl, domain, audioRoots }) {
    this.store = store;
    this.esl = esl;
    this.domain = domain;
    this.audioPattern = buildAudioPattern(audioRoots?.length ? audioRoots : defaultAudioRoots);
  }

  list(filters) {
    return this.store.list(filters);
  }

  get(id) {
    return this.store.get(id);
  }

  async create(input, { idempotencyKey } = {}) {
    const existing = this.store.getByIdempotencyKey(idempotencyKey);
    if (existing) return { broadcast: existing, replayed: true };

    const name = String(input.name ?? "实时广播").trim();
    const targets = Array.isArray(input.targets) ? [...new Set(input.targets.map(String))] : [];
    const audio = String(input.audio ?? "");
    const callerId = String(input.callerId ?? "9999");
    const volume = Number(input.volume ?? 75);
    const playMode = playModes.has(String(input.playMode ?? "").toUpperCase()) ? String(input.playMode).toUpperCase() : "ONCE";

    if (!name || name.length > 100) throw problem("name must contain 1-100 characters");
    if (!targets.length || targets.length > 500 || targets.some((target) => !extensionPattern.test(target))) {
      throw problem("targets must contain 1-500 numeric SIP extensions");
    }
    if (!approvedAudio(audio, this.audioPattern)) {
      throw problem("audio must be an approved WAV/MP3 path, media playlist, or a safe tone_stream test URI");
    }
    if (!extensionPattern.test(callerId)) throw problem("callerId must be numeric");
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw problem("volume must be an integer from 0 to 100");

    const now = new Date().toISOString();
    const broadcast = this.store.create({
      id: randomUUID(),
      name,
      type: input.presetId ? "PRESET" : "REALTIME",
      presetId: input.presetId ?? null,
      controllerUuid: input.controllerUuid ?? null,
      state: "DISPATCHING",
      audio,
      callerId,
      volume,
      playMode,
      sourceType: ["PLAYLIST", "MIXED"].includes(input.sourceType) ? input.sourceType : "FILE",
      sourceId: input.sourceId ? String(input.sourceId) : null,
      sourceName: input.sourceName ? String(input.sourceName).slice(0, 100) : null,
      sourceItems: Array.isArray(input.sourceItems) ? input.sourceItems.slice(0, 50) : [],
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: null,
      targets: targets.map((extension) => ({
        id: randomUUID(), extension, state: "PENDING", channelUuid: null, jobUuid: null,
        answeredAt: null, finishedAt: null, failureCause: null,
      })),
    }, idempotencyKey);

    const results = await Promise.allSettled(broadcast.targets.map(async (target) => {
      const channelUuid = randomUUID();
      const variables = [
        `origination_uuid=${channelUuid}`,
        `origination_caller_id_number=${callerId}`,
        "ignore_early_media=true",
        `playback_volume=${Math.round((volume - 50) / 2)}`,
        `sip_broadcast_id=${broadcast.id}`,
        `sip_target_id=${target.id}`,
      ].join(",");
      const dialString = `{${variables}}user/${target.extension}@${this.domain}`;
      this.store.updateTarget(broadcast.id, target.id, (storedTarget) => {
        storedTarget.channelUuid = channelUuid;
        storedTarget.state = "QUEUED";
      });
      const result = await this.esl.execute(`originate ${dialString} &${playApplication(playMode)}(${audio})`, { background: true });
      this.store.updateTarget(broadcast.id, target.id, (storedTarget) => {
        storedTarget.jobUuid = result.jobUuid;
      });
      return target.id;
    }));

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.store.updateTarget(broadcast.id, broadcast.targets[index].id, (target) => {
          target.state = "FAILED";
          target.failureCause = result.reason?.message ?? "dispatch_failed";
          target.finishedAt = new Date().toISOString();
        });
      }
    });
    const updated = this.store.update(broadcast.id, aggregate);
    return { broadcast: updated, replayed: false };
  }

  async cancel(id) {
    const broadcast = this.store.get(id);
    if (!broadcast) throw problem("broadcast not found", 404);
    if (["SUCCEEDED", "PARTIAL_FAILED", "FAILED", "CANCELED"].includes(broadcast.state)) return broadcast;
    this.store.update(id, (item) => { item.state = "CANCELED_REQUESTED"; });
    const results = await Promise.allSettled(broadcast.targets.filter((target) => target.channelUuid && !terminalTargetStates.has(target.state)).map((target) => (
      this.esl.execute(`uuid_kill ${target.channelUuid} NORMAL_CLEARING`)
    )));
    const failed = results.find((result) => result.status === "rejected" && !/no such channel|invalid uuid/i.test(result.reason?.message ?? ""));
    if (failed) throw failed.reason; // Keep CANCELED_REQUESTED so the caller can retry.
    return this.store.update(id, (item) => {
      item.targets.forEach((target) => {
        if (!terminalTargetStates.has(target.state)) {
          target.state = "CANCELED";
          target.finishedAt = new Date().toISOString();
        }
      });
      item.state = "CANCELED";
      item.finishedAt = new Date().toISOString();
    });
  }

  handleEvent(event) {
    const eventName = event["Event-Name"];
    const broadcastId = event.variable_sip_broadcast_id;
    const targetId = event.variable_sip_target_id;

    if (eventName === "BACKGROUND_JOB" && String(event["Job-Command-Output"] ?? "").startsWith("-ERR")) {
      const match = this.store.findTargetByJobUuid(event["Job-UUID"]);
      if (match) this.failTarget(match.broadcastId, match.targetId, event["Job-Command-Output"]);
      return;
    }
    if (!broadcastId || !targetId || !this.store.get(broadcastId)) return;
    if (["CANCELED", "CANCELED_REQUESTED"].includes(this.store.get(broadcastId).state)) return;
    if (eventName === "CHANNEL_ANSWER") {
      this.store.updateTarget(broadcastId, targetId, (target, broadcast) => {
        target.state = "ANSWERED";
        target.answeredAt = new Date().toISOString();
        broadcast.state = "RUNNING";
      });
    }
    if (eventName === "CHANNEL_HANGUP_COMPLETE") {
      const cause = event["Hangup-Cause"] ?? "UNKNOWN";
      this.store.updateTarget(broadcastId, targetId, (target, broadcast) => {
        target.state = target.answeredAt && cause === "NORMAL_CLEARING" ? "SUCCEEDED" : "FAILED";
        target.failureCause = target.state === "FAILED" ? cause : null;
        target.finishedAt = new Date().toISOString();
        aggregate(broadcast);
      });
    }
  }

  failTarget(broadcastId, targetId, cause) {
    this.store.updateTarget(broadcastId, targetId, (target, broadcast) => {
      if (["CANCELED", "CANCELED_REQUESTED"].includes(broadcast.state)) return;
      target.state = "FAILED";
      target.failureCause = cause;
      target.finishedAt = new Date().toISOString();
      aggregate(broadcast);
    });
  }
}
