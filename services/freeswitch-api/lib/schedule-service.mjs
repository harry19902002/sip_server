import { buildAudio, expandSources } from "./play-source.mjs";

/**
 * 判断一次 PATCH 是否「只切换启用状态」。
 * 前端暂停/启用计划时只发 { enabled }，这类请求不应因音源或分区
 * 已被删除而被拒（否则计划会卡死，无法暂停、无法删除）。
 */
function onlyTogglesEnabled(input) {
  const keys = Object.keys(input ?? {});
  return keys.length === 1 && keys[0] === "enabled";
}

export class ScheduleService {
  constructor({ store, media, zones, broadcasts }) {
    this.store = store;
    this.media = media;
    this.zones = zones;
    this.broadcasts = broadcasts;
    this.executing = new Set();
    // 已排定「到时自动停止」的广播：broadcastId -> { planId, stopAt(ms), timer }
    this.pendingStops = new Map();
  }

  enrich(plan) {
    const zoneMap = new Map(this.zones.list().map((zone) => [zone.id, zone]));
    const broadcast = plan.lastBroadcastId ? this.broadcasts.get(plan.lastBroadcastId) : null;
    // 播放内容可能是多选（sourceItems），补上每个音源的可读名称与文件数；
    // 同时保留 media 字段以兼容旧的单文件计划。
    const sources = (plan.sourceItems ?? []).map((source) => {
      if (source.type === "FILE") {
        const file = this.media.getFile(source.id);
        return { ...source, name: file?.originalName ?? "音频已删除", fileCount: 1, missing: !file };
      }
      const playlist = this.media.getPlaylist(source.id);
      return { ...source, name: playlist?.name ?? "播放列表已删除", fileCount: playlist?.files.length ?? 0, missing: !playlist };
    });
    const legacyFile = plan.mediaFileId ? this.media.getFile(plan.mediaFileId) : null;
    return {
      ...plan,
      media: legacyFile,
      sources,
      zones: plan.zoneIds.map((id) => zoneMap.get(id)).filter(Boolean),
      lastBroadcast: broadcast,
    };
  }

  list() { return this.store.list().map((plan) => this.enrich(plan)); }
  get(id) { const plan = this.store.get(id); return plan ? this.enrich(plan) : null; }

  validate(input) {
    // 音源存在性校验交给 expandSources（它同时负责展开与报错），
    // 这里只做分区校验，避免重复实现两套判断。
    const knownZones = new Set(this.zones.list().map((zone) => zone.id));
    if (!Array.isArray(input.zoneIds) || input.zoneIds.some((id) => !knownZones.has(String(id)))) {
      throw Object.assign(new Error("one or more zones were not found"), { status: 404 });
    }
    expandSources({ sources: input.sourceItems, mediaFileId: input.mediaFileId, media: this.media });
  }

  create(input) { this.validate(input); return this.enrich(this.store.create(input)); }
  update(id, input) {
    const current = this.store.get(id);
    if (!current) throw Object.assign(new Error("schedule not found"), { status: 404 });
    // 只切换启用状态（暂停/启用）时，不应校验播放内容与分区是否还在：
    // 媒体被清理、分区被删除后，用户仍必须能暂停或删除该计划，
    // 否则计划会卡在「改不动」的状态。真正执行时若内容缺失，
    // runDue 会失败并把原因写入 lastError。
    if (!onlyTogglesEnabled(input)) this.validate({ ...current, ...input });
    return this.enrich(this.store.update(id, input));
  }
  delete(id) {
    const plan = this.store.get(id);
    if (plan) this.cancelPendingStop(plan.lastBroadcastId);
    return this.store.delete(id);
  }

  // ---------- 时长控制 ----------

  cancelPendingStop(broadcastId) {
    if (!broadcastId) return;
    const entry = this.pendingStops.get(broadcastId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingStops.delete(broadcastId);
  }

  /**
   * 为循环/随机播放排定自动停止。
   * durationMinutes <= 0 表示「一直播放」，不排定停止（由用户手动停止）。
   * 返回停止时间戳（毫秒），未排定时返回 null。
   */
  scheduleStop(broadcastId, durationMinutes) {
    if (!broadcastId || !(durationMinutes > 0)) return null;
    this.cancelPendingStop(broadcastId);
    const stopAt = Date.now() + durationMinutes * 60_000;
    const timer = setTimeout(() => {
      this.pendingStops.delete(broadcastId);
      this.broadcasts.cancel(broadcastId).catch(() => undefined);
    }, durationMinutes * 60_000);
    timer.unref?.();
    this.pendingStops.set(broadcastId, { stopAt, timer });
    return stopAt;
  }

  async runDue(now = new Date()) {
    await Promise.allSettled(this.store.due(now).map(async (plan) => {
      if (this.executing.has(plan.id)) return;
      this.executing.add(plan.id);
      const scheduledAt = plan.nextRunAt;
      try {
        const selectedZones = this.zones.list().filter((zone) => plan.zoneIds.includes(zone.id));
        const targets = [...new Set(selectedZones.flatMap((zone) => zone.terminalIds).map((id) => id.split("@")[0]).filter((extension) => /^\d{2,12}$/.test(extension)))];
        if (!targets.length) throw new Error("所选分区没有可下发的 SIP 终端");

        // 每次触发都重新展开音源：媒体库可能在计划创建后被改动，
        // 且随机播放需要每次执行都重新洗牌。
        const expanded = expandSources({ sources: plan.sourceItems, mediaFileId: plan.mediaFileId, media: this.media });
        const audio = buildAudio(expanded.paths, plan.playMode);

        const result = await this.broadcasts.create({
          name: `定时广播 · ${plan.name}`,
          targets,
          audio,
          callerId: "9999",
          volume: plan.volume,
          playMode: plan.playMode,
          // 定时计划里「循环」和「随机」都表示持续播放到时长结束：
          // 随机只决定顺序（已在上游洗牌），是否重复播放由 loop 决定。
          // 若不显式传 loop，SHUFFLE 会退化成「播一遍就停」，
          // 与界面上「随机播放 + 30 分钟」的承诺不符。
          loop: plan.playMode !== "ONCE",
          sourceType: expanded.sourceType,
          sourceId: expanded.sourceId,
          sourceName: expanded.sourceName,
          sourceItems: expanded.sourceItems,
        }, { idempotencyKey: `schedule:${plan.id}:${scheduledAt}` });

        // 循环/随机 + 指定时长 → 到时自动停止；时长为 0 则一直播放。
        this.scheduleStop(result.broadcast.id, plan.playMode === "ONCE" ? 0 : plan.durationMinutes);
        this.store.complete(plan.id, { broadcastId: result.broadcast.id, scheduledAt });
      } catch (error) {
        this.store.complete(plan.id, { error: error.message ?? "计划执行失败", scheduledAt });
      } finally {
        this.executing.delete(plan.id);
      }
    }));
  }
}
