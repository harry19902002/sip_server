import { randomInt } from "node:crypto";
import { validatePreset } from "./preset-store.mjs";

const finished = new Set(["SUCCEEDED", "PARTIAL_FAILED", "FAILED", "CANCELED"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }

export class PresetService {
  constructor({ store, media, zones, broadcasts, esl }) {
    Object.assign(this, { store, media, zones, broadcasts, esl });
    this.sessions = new Map();
    this.reconciling = false;
    // Restore associations after an API restart. Reconciliation verifies live channels.
    for (const broadcast of broadcasts.list()) {
      if (broadcast.presetId && !finished.has(broadcast.state)) {
        this.sessions.set(broadcast.presetId, { broadcastId: broadcast.id, controllerUuid: broadcast.controllerUuid, stopped: false, ready: Promise.resolve() });
      }
    }
  }
  resolve(input, { requireTargets = false, shuffle = false } = {}) {
    const preset = validatePreset(input);
    const selectedZones = preset.zoneIds.map((id) => {
      const zone = this.zones.list().find((item) => item.id === id);
      if (!zone) throw problem("所选分区已不存在，请编辑预设", 409);
      return zone;
    });
    const targets = [...new Set(selectedZones.flatMap((zone) => zone.terminalIds).map((id) => id.split("@")[0]))];
    if (targets.some((extension) => !/^\d{2,12}$/.test(extension))) throw problem("分区中包含不支持的 SIP 分机号码");
    if (requireTargets && !targets.length) throw problem("所选分区没有可广播的终端");
    if (targets.length > 500) throw problem("广播终端总数不能超过 500 台");
    const paths = [];
    const sourceItems = preset.sources.map((source) => {
      if (source.type === "FILE") {
        const file = this.media.getFile(source.id);
        if (!file) throw problem("所选音频已不存在，请编辑预设", 409);
        paths.push(file.freeswitchPath);
        return { ...source, name: file.originalName, fileCount: 1 };
      }
      const playlist = this.media.getPlaylist(source.id);
      if (!playlist?.files.length) throw problem("所选播放列表已不存在或没有音频，请编辑预设", 409);
      paths.push(...playlist.files.map((file) => file.freeswitchPath));
      return { ...source, name: playlist.name, fileCount: playlist.files.length };
    });
    if (paths.length > 100) throw problem("展开播放列表后音频总数不能超过 100 个");
    if (shuffle && preset.playMode === "SHUFFLE") {
      for (let index = paths.length - 1; index > 0; index -= 1) {
        const swap = randomInt(index + 1);
        [paths[index], paths[swap]] = [paths[swap], paths[index]];
      }
    }
    return { ...preset, zones: selectedZones, targets, sourceItems, audio: paths.length === 1 ? paths[0] : `file_string://${paths.join("!")}` };
  }
  enrich(preset) {
    const session = this.sessions.get(preset.id);
    const broadcast = session?.broadcastId ? this.broadcasts.get(session.broadcastId) : this.broadcasts.list().find((item) => item.presetId === preset.id) ?? null;
    let resolved; let error = null;
    try { resolved = this.resolve(preset, { requireTargets: true }); } catch (failure) { error = failure.message; }
    return { ...preset, zones: this.zones.list().filter((zone) => preset.zoneIds.includes(zone.id)), sourceItems: resolved?.sourceItems ?? [], error,
      active: Boolean(session && (!session.broadcastId || !finished.has(broadcast?.state))), trigger: session?.controllerUuid ? "SIP" : "WEB", broadcast };
  }
  list() { return this.store.list().map((item) => this.enrich(item)); }
  get(id) { const preset = this.store.get(id); return preset ? this.enrich(preset) : null; }
  create(input) { this.resolve(input); return this.enrich(this.store.create(input)); }
  update(id, input) {
    const current = this.store.get(id);
    if (!current) throw problem("预设广播不存在", 404);
    if (this.sessions.has(id)) throw problem("请先停止广播再编辑预设", 409);
    this.resolve({ ...current, ...input }); return this.enrich(this.store.update(id, input));
  }
  delete(id) {
    if (this.sessions.has(id)) throw problem("请先停止广播再删除预设", 409);
    return this.store.delete(id);
  }
  async start(id, { controllerUuid = null } = {}) {
    const preset = this.store.get(id);
    if (!preset) throw problem("预设广播不存在", 404);
    if (this.sessions.has(id)) throw problem("该预设广播正在运行，请先停止", 409);
    const input = this.resolve(preset, { requireTargets: true, shuffle: true });
    const session = { controllerUuid, broadcastId: null, stopped: false, ready: null };
    // Reserve before the first await: web requests and SIP calls share this lock.
    this.sessions.set(id, session);
    session.ready = (async () => {
      try {
        const result = await this.broadcasts.create({ ...input, name: `预设广播 · ${preset.name}`, callerId: preset.sipNumber,
          presetId: id, controllerUuid, sourceType: input.sourceItems.length === 1 ? input.sourceItems[0].type : "MIXED",
          sourceName: input.sourceItems.map((source) => source.name).join("、") });
        session.broadcastId = result.broadcast.id;
        if (session.stopped) await this.broadcasts.cancel(session.broadcastId);
        if (session.stopped || finished.has(this.broadcasts.get(session.broadcastId).state)) {
          await this.killController(session); this.sessions.delete(id);
        }
      } catch (error) {
        // Retain a partially dispatched task when cancellation failed; the
        // reconciliation loop will retry rather than leave looping audio behind.
        if (session.broadcastId && !finished.has(this.broadcasts.get(session.broadcastId)?.state)) session.stopped = true;
        else this.sessions.delete(id);
        await this.killController(session, "CALL_REJECTED").catch(() => undefined);
        throw error;
      }
    })();
    await session.ready;
    return this.get(id);
  }
  async killController(session, cause = "NORMAL_CLEARING") {
    if (session.controllerUuid) await this.esl.execute(`uuid_kill ${session.controllerUuid} ${cause}`).catch((error) => {
      if (!/no such channel|invalid uuid/i.test(error.message)) throw error;
    });
  }
  async stop(id) {
    if (!this.store.get(id)) throw problem("预设广播不存在", 404);
    const session = this.sessions.get(id);
    if (!session) return this.get(id);
    session.stopped = true;
    await session.ready.catch(() => undefined);
    if (session.broadcastId) await this.broadcasts.cancel(session.broadcastId);
    await this.killController(session);
    if (this.sessions.get(id) === session) this.sessions.delete(id);
    return this.get(id);
  }
  async handleEvent(event) {
    const uuid = event["Unique-ID"];
    if (event["Event-Name"] === "CHANNEL_HANGUP_COMPLETE") {
      for (const [id, session] of this.sessions) {
        if (session.controllerUuid === uuid) { await this.stop(id); return; }
      }
      await this.finishCompleted();
    }
    if (event["Event-Name"] !== "CHANNEL_PARK" || !/^88\d{4}$/.test(event.variable_sip_preset_number ?? "") || !uuidPattern.test(uuid ?? "")) return;
    const preset = this.store.byNumber(event.variable_sip_preset_number);
    // Only digest-authenticated SIP callers may trigger presets.
    if (!preset || !event.variable_sip_auth_username) {
      await this.esl.execute(`uuid_kill ${uuid} CALL_REJECTED`); return;
    }
    const existing = this.sessions.get(preset.id);
    if (existing?.controllerUuid === uuid) return; // duplicate park event
    if (existing) { await this.esl.execute(`uuid_kill ${uuid} USER_BUSY`); return; }
    try { await this.start(preset.id, { controllerUuid: uuid }); }
    catch (error) { await this.esl.execute(`uuid_kill ${uuid} CALL_REJECTED`).catch(() => undefined); throw error; }
  }
  async finishCompleted() {
    for (const [id, session] of this.sessions) {
      const broadcast = session.broadcastId ? this.broadcasts.get(session.broadcastId) : null;
      if (broadcast && finished.has(broadcast.state)) {
        await this.killController(session);
        if (this.sessions.get(id) === session) this.sessions.delete(id);
      }
    }
  }
  async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      for (const [id, session] of this.sessions) {
        if (!session.broadcastId) continue;
        if (session.stopped) { await this.stop(id); continue; }
        if (session.controllerUuid) {
          const result = await this.esl.execute(`uuid_exists ${session.controllerUuid}`);
          if (result.body === "false") await this.stop(id);
        }
        const broadcast = this.broadcasts.get(session.broadcastId);
        for (const target of broadcast?.targets ?? []) {
          if (!target.channelUuid || ["SUCCEEDED", "FAILED", "CANCELED"].includes(target.state)) continue;
          const result = await this.esl.execute(`uuid_exists ${target.channelUuid}`);
          if (result.body === "false") this.broadcasts.failTarget(broadcast.id, target.id, "CHANNEL_LOST");
        }
      }
      await this.finishCompleted();
    } finally { this.reconciling = false; }
  }
}
