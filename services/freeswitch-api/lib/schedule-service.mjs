export class ScheduleService {
  constructor({ store, media, zones, broadcasts }) {
    this.store = store;
    this.media = media;
    this.zones = zones;
    this.broadcasts = broadcasts;
    this.executing = new Set();
  }
  enrich(plan) {
    const file = this.media.getFile(plan.mediaFileId);
    const zoneMap = new Map(this.zones.list().map((zone) => [zone.id, zone]));
    const broadcast = plan.lastBroadcastId ? this.broadcasts.get(plan.lastBroadcastId) : null;
    return { ...plan, media: file, zones: plan.zoneIds.map((id) => zoneMap.get(id)).filter(Boolean), lastBroadcast: broadcast };
  }
  list() { return this.store.list().map((plan) => this.enrich(plan)); }
  get(id) { const plan = this.store.get(id); return plan ? this.enrich(plan) : null; }
  validate(input) {
    if (!this.media.getFile(String(input.mediaFileId ?? ""))) throw Object.assign(new Error("audio file not found"), { status: 404 });
    const knownZones = new Set(this.zones.list().map((zone) => zone.id));
    if (!Array.isArray(input.zoneIds) || input.zoneIds.some((id) => !knownZones.has(String(id)))) throw Object.assign(new Error("one or more zones were not found"), { status: 404 });
  }
  create(input) { this.validate(input); return this.enrich(this.store.create(input)); }
  update(id, input) { const current = this.store.get(id); if (!current) throw Object.assign(new Error("schedule not found"), { status: 404 }); this.validate({ ...current, ...input }); return this.enrich(this.store.update(id, input)); }
  delete(id) { return this.store.delete(id); }
  async runDue(now = new Date()) {
    await Promise.allSettled(this.store.due(now).map(async (plan) => {
      if (this.executing.has(plan.id)) return;
      this.executing.add(plan.id);
      const scheduledAt = plan.nextRunAt;
      try {
        const selectedZones = this.zones.list().filter((zone) => plan.zoneIds.includes(zone.id));
        const targets = [...new Set(selectedZones.flatMap((zone) => zone.terminalIds).map((id) => id.split("@")[0]).filter((extension) => /^\d{2,12}$/.test(extension)))];
        const file = this.media.getFile(plan.mediaFileId);
        if (!file) throw new Error("媒体文件已不存在");
        if (!targets.length) throw new Error("所选分区没有可下发的 SIP 终端");
        const result = await this.broadcasts.create({ name: `定时广播 · ${plan.name}`, targets, audio: file.freeswitchPath, callerId: "9999", volume: plan.volume }, { idempotencyKey: `schedule:${plan.id}:${scheduledAt}` });
        this.store.complete(plan.id, { broadcastId: result.broadcast.id, scheduledAt });
      } catch (error) {
        this.store.complete(plan.id, { error: error.message ?? "计划执行失败", scheduledAt });
      } finally {
        this.executing.delete(plan.id);
      }
    }));
  }
}
