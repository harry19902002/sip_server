import { randomUUID } from "node:crypto";

const extensionPattern = /^[0-9]{2,12}$/;
const toneAudioPattern = /^tone_stream:\/\/%\([0-9]{1,5},[0-9]{1,5},[0-9]{2,5}\)$/;
const terminalTargetStates = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
// 广播整体的终态集合：进入终态后不能再调音量，但可以重发。
const terminalBroadcastStates = new Set(["SUCCEEDED", "PARTIAL_FAILED", "FAILED", "CANCELED"]);
// 播放模式：ONCE 单次播放、LOOP 循环播放、SHUFFLE 随机播放（顺序已在上游打乱）。
const playModes = new Set(["ONCE", "LOOP", "SHUFFLE"]);

// ---------- 音量 ----------
//
// FreeSWITCH 运行时可用的「单通道音量」接口只有 uuid_audio（mod_commands），
// 它落到 switch_ivr_session_audio()，其中对 level 有硬性守卫：
//     if (level < 5 && level > -5) { ... }
// 即只有 -4..4 的整数生效（见 src/switch_ivr_async.c），再经
// switch_change_sln_volume() 的 8 档换算表作用到音频（src/switch_resample.c）。
//
// 注意：原先下发的 `playback_volume` 通道变量在整个 FreeSWITCH 源码树中
// 不存在任何引用，属于无效变量 —— 音量此前从未真正生效。现已统一改为
// 「应答后挂 uuid_audio 媒体 bug」，初始音量与运行中调音走同一条路径。
const MIN_VOLUME_LEVEL = -4;
const MAX_VOLUME_LEVEL = 4;

/**
 * 把界面上的 0..100 音量百分比换算成 FreeSWITCH 支持的 -4..4 档位：
 * 0% → -4（最小声）、50% → 0（原始音量）、100% → +4（最大声）。
 * 50% 恰好等于「不做任何处理」，因此缺省值取 50 可保持原有响度。
 */
export function volumeToLevel(volume) {
  const percent = Math.max(0, Math.min(100, Number(volume)));
  const safePercent = Number.isFinite(percent) ? percent : 50;
  return Math.max(MIN_VOLUME_LEVEL, Math.min(MAX_VOLUME_LEVEL, Math.round((safePercent - 50) / 12.5)));
}
// 循环播放使用 endless_playback，持续循环直到任务被取消或终端挂断；
// 其余模式使用 playback 顺序播放一次。
//
// loop 显式传入时以它为准，否则沿用 playMode 的默认语义（ONCE 与 SHUFFLE 播一遍、
// LOOP 一直播）。定时计划需要「随机后持续播放 N 分钟」，仅靠 playMode 表达不了，
// 因此由调用方显式给 loop。
function playApplication(playMode, loop) {
  const shouldLoop = loop === undefined ? playMode === "LOOP" : loop;
  return shouldLoop ? "endless_playback" : "playback";
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
  if (broadcast.state === "CANCELED" || broadcast.state === "CANCELED_REQUESTED") return;  const states = broadcast.targets.map((target) => target.state);
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
    // 缺省 50% 等价于 uuid_audio level 0，即不做任何增益处理（保持原始响度）。
    const volume = Number(input.volume ?? 50);
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
      // 重发来源：便于任务中心回溯「由哪个已结束任务重新发起」。
      replayOfId: input.replayOfId ? String(input.replayOfId) : null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: null,
      targets: targets.map((extension) => ({
        id: randomUUID(), extension, state: "PENDING", channelUuid: null, jobUuid: null,
        answeredAt: null, finishedAt: null, failureCause: null,
      })),
    }, idempotencyKey);

    // 初始音量不在拨号串里设置：应答事件（CHANNEL_ANSWER）到达后再施加，
    // 与运行中调音共用 applyVolume() 这一条路径。这样做的两个好处：
    //   1. 只有一条音量代码路径，行为一致且可测；
    //   2. 呼叫振铃期间若用户调整了音量，应答时会直接采用最新值。
    const results = await Promise.allSettled(broadcast.targets.map(async (target) => {
      const channelUuid = randomUUID();
      const variables = [
        `origination_uuid=${channelUuid}`,
        `origination_caller_id_number=${callerId}`,
        "ignore_early_media=true",
        `sip_broadcast_id=${broadcast.id}`,
        `sip_target_id=${target.id}`,
      ].join(",");
      const dialString = `{${variables}}user/${target.extension}@${this.domain}`;
      this.store.updateTarget(broadcast.id, target.id, (storedTarget) => {
        storedTarget.channelUuid = channelUuid;
        storedTarget.state = "QUEUED";
      });
      const result = await this.esl.execute(`originate ${dialString} &${playApplication(playMode, input.loop)}(${audio})`, { background: true });
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
    if (terminalBroadcastStates.has(broadcast.state)) return broadcast;
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
      const updated = this.store.updateTarget(broadcastId, targetId, (target, broadcast) => {
        target.state = "ANSWERED";
        target.answeredAt = new Date().toISOString();
        broadcast.state = "RUNNING";
      });
      // 应答是施加初始音量的最早可靠时机（此刻 CF_ANSWERED 已置位）。
      // 顺带覆盖「振铃期间用户已调音量」的情况：直接用记录里的最新值。
      const channelUuid = event["Unique-ID"] ?? updated?.targets.find((item) => item.id === targetId)?.channelUuid;
      if (channelUuid && updated) {
        this.applyVolume(channelUuid, updated.volume).catch((error) => {
          // 音量施加失败不应影响广播本身，仅记录，避免事件回调抛出。
          console.error(JSON.stringify({ component: "broadcast-volume", channelUuid, error: error.message }));
        });
      }
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

  /**
   * 对单个信道施加音量：uuid_audio 通过媒体 bug 改写 write 方向的音频帧。
   * 重复调用是安全的 —— FreeSWITCH 会复用已挂载的媒体 bug 并就地更新档位
   * （见 switch_ivr_session_audio 的 existing 分支），不会叠加多个 bug。
   */
  async applyVolume(channelUuid, volume) {
    const level = volumeToLevel(volume);
    try {
      await this.esl.execute(`uuid_audio ${channelUuid} start write level ${level}`);
      return { ok: true, level };
    } catch (error) {
      // 信道可能刚好挂断（uuid_audio 会返回 "-ERR No such channel!"），
      // 这属于正常竞态，交给调用方决定是否忽略。
      return { ok: false, level, error: error.message };
    }
  }

  /**
   * 调整「播放中」任务的音量：写回记录，并对仍未结束的目标信道逐个施加。
   * 校验方式与创建时一致（0-100 的整数百分比）。
   */
  async setVolume(id, volume) {
    const broadcast = this.store.get(id);
    if (!broadcast) throw problem("broadcast not found", 404);
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
      throw problem("volume must be an integer from 0 to 100");
    }
    if (terminalBroadcastStates.has(broadcast.state)) {
      throw problem("已结束的任务不能调整音量，请重发后再设置", 409);
    }

    const applied = await Promise.all(broadcast.targets
      .filter((target) => target.channelUuid && !terminalTargetStates.has(target.state))
      .map((target) => this.applyVolume(target.channelUuid, volume)));
    const updated = this.store.update(id, (item) => { item.volume = volume; });
    const succeeded = applied.filter((item) => item.ok).length;
    return { broadcast: updated, applied: succeeded, attempted: applied.length };
  }

  /**
   * 重发已结束的广播：复用原任务的播放内容、目标、音量与播放模式，
   * 生成一个新的任务记录（旧记录保持不可变，便于审计）。
   */
  async replay(id, { idempotencyKey } = {}) {
    const source = this.store.get(id);
    if (!source) throw problem("broadcast not found", 404);
    if (!terminalBroadcastStates.has(source.state)) {
      throw problem("该任务尚未结束，无需重发；如需中断请先停止", 409);
    }
    const targets = source.targets.map((target) => target.extension);
    if (!targets.length) throw problem("原任务没有可下发的终端，无法重发");

    return this.create({
      name: source.name,
      targets,
      audio: source.audio,
      callerId: source.callerId,
      volume: source.volume,
      playMode: source.playMode,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceName: source.sourceName,
      sourceItems: source.sourceItems,
      replayOfId: source.id,
    }, { idempotencyKey });
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
