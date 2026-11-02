import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const repeats = new Set(["ONCE", "DAILY", "WEEKDAYS", "WEEKLY"]);
// 播放模式：ONCE 单次、LOOP 循环、SHUFFLE 随机。
const playModes = new Set(["ONCE", "LOOP", "SHUFFLE"]);
// 播放时长上限 24 小时；仅循环/随机使用，0 表示一直播放到手动停止。
const MAX_DURATION_MINUTES = 24 * 60;
const MAX_SOURCES = 50;

function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }
function clone(value) { return structuredClone(value); }

function localParts(date, offsetMinutes) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function localDate(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function localToUtc(date, time, offsetMinutes) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000);
}

function addLocalDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return localDate({ year: result.getUTCFullYear(), month: result.getUTCMonth() + 1, day: result.getUTCDate() });
}

function weekday(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function nextRunAt(plan, after = new Date(), offsetMinutes = 480) {
  const first = localToUtc(plan.date, plan.time, offsetMinutes);
  if (plan.repeat === "ONCE") return first > after ? first.toISOString() : null;
  let date = localDate(localParts(after, offsetMinutes));
  if (date < plan.date) date = plan.date;
  const startWeekday = weekday(plan.date);
  for (let index = 0; index < 3700; index += 1) {
    const candidateDate = addLocalDays(date, index);
    const day = weekday(candidateDate);
    const allowed = plan.repeat === "DAILY" || (plan.repeat === "WEEKDAYS" && day >= 1 && day <= 5) || (plan.repeat === "WEEKLY" && day === startWeekday);
    if (allowed) {
      const candidate = localToUtc(candidateDate, plan.time, offsetMinutes);
      if (candidate > after && candidate >= first) return candidate.toISOString();
    }
  }
  return null;
}

function validated(input) {
  const name = String(input.name ?? "").trim();
  const zoneIds = Array.isArray(input.zoneIds) ? [...new Set(input.zoneIds.map(String))] : [];
  const repeat = String(input.repeat ?? "ONCE");
  const date = String(input.date ?? "");
  const time = String(input.time ?? "");
  const volume = Number(input.volume ?? 75);
  const playMode = String(input.playMode ?? "ONCE").toUpperCase();

  // 播放内容：优先用 sourceItems（文件/播放列表多选），否则兼容旧的单个 mediaFileId。
  const rawSources = Array.isArray(input.sourceItems) ? input.sourceItems : [];
  const sourceItems = rawSources
    .map((source) => ({
      type: String(source?.type ?? ""),
      id: String(source?.id ?? ""),
    }))
    .filter((source) => (source.type === "FILE" || source.type === "PLAYLIST") && source.id);
  const mediaFileId = String(input.mediaFileId ?? "");

  if (!name || name.length > 100) throw problem("name must contain 1-100 characters");
  if (!zoneIds.length) throw problem("zoneIds must contain at least one zone");
  if (!repeats.has(repeat)) throw problem("repeat must be ONCE, DAILY, WEEKDAYS, or WEEKLY");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw problem("date must be a valid YYYY-MM-DD date");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw problem("time must use HH:mm");
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw problem("volume must be an integer from 0 to 100");
  if (!playModes.has(playMode)) throw problem("playMode must be ONCE, LOOP, or SHUFFLE");
  if (!sourceItems.length && !mediaFileId) throw problem("at least one play source is required");
  if (sourceItems.length > MAX_SOURCES) throw problem(`at most ${MAX_SOURCES} play sources are allowed`);

  // 播放时长只对循环/随机有意义（单次播放按音频自身长度播完即止）。
  const rawDuration = input.durationMinutes;
  let durationMinutes = 0;
  if (playMode !== "ONCE") {
    durationMinutes = Number(rawDuration ?? 0);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 0 || durationMinutes > MAX_DURATION_MINUTES) {
      throw problem(`durationMinutes must be an integer from 0 to ${MAX_DURATION_MINUTES} (0 = play until stopped)`);
    }
  }

  return { name, mediaFileId, sourceItems, zoneIds, repeat, date, time, volume, playMode, durationMinutes };
}

export class ScheduleStore {
  constructor(file, { clock = () => new Date(), offsetMinutes = 480 } = {}) {
    this.file = file;
    this.clock = clock;
    this.offsetMinutes = offsetMinutes;
    mkdirSync(dirname(file), { recursive: true });
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { schedules: [] };
    if (!Array.isArray(this.state.schedules)) this.state.schedules = [];
  }
  persist() { const temporary = `${this.file}.tmp`; writeFileSync(temporary, JSON.stringify(this.state, null, 2)); renameSync(temporary, this.file); }

  /**
   * 重新从磁盘加载。供备份导入 / 恢复出厂设置后同步内存状态，
   * 否则调度器仍按旧计划表执行，且下一次写操作会覆盖刚导入的数据。
   */
  reload() {
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { schedules: [] };
    if (!Array.isArray(this.state.schedules)) this.state.schedules = [];
    return this;
  }
  list() { return this.state.schedules.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(clone); }
  get(id) { const plan = this.state.schedules.find((item) => item.id === id); return plan ? clone(plan) : null; }
  create(input) {
    const values = validated(input);
    const now = this.clock();
    const plan = { id: randomUUID(), ...values, enabled: true, nextRunAt: nextRunAt(values, now, this.offsetMinutes), lastRunAt: null, lastBroadcastId: null, lastError: null, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    if (!plan.nextRunAt) throw problem("the first execution time must be in the future");
    this.state.schedules.push(plan); this.persist(); return clone(plan);
  }
  update(id, input) {
    const plan = this.state.schedules.find((item) => item.id === id); if (!plan) throw problem("schedule not found", 404);
    const values = validated({ ...plan, ...input });
    const enabled = input.enabled === undefined ? plan.enabled : Boolean(input.enabled);
    const next = enabled ? nextRunAt(values, this.clock(), this.offsetMinutes) : null;
    // 只有「启用且算不出下次执行时间」才是矛盾状态：
    // 单次计划的执行时刻已过、或周期计划已超出可计算范围。
    // 此时直接报错，而不是留下 enabled=true 却永不到期的僵尸计划——
    // 后者在界面上显示「已启用」，实际永远不会触发，用户无从察觉。
    if (enabled && !next) {
      throw problem(
        values.repeat === "ONCE"
          ? "该单次计划的执行时间已过，无法直接启用；请把执行日期/时间改到将来再启用"
          : "无法计算下次执行时间，请检查执行日期/时间",
      );
    }
    Object.assign(plan, values, { enabled, nextRunAt: next, updatedAt: this.clock().toISOString() });
    this.persist(); return clone(plan);
  }
  delete(id) { const index = this.state.schedules.findIndex((item) => item.id === id); if (index < 0) throw problem("schedule not found", 404); const [plan] = this.state.schedules.splice(index, 1); this.persist(); return clone(plan); }
  due(now = this.clock()) { return this.list().filter((plan) => plan.enabled && plan.nextRunAt && new Date(plan.nextRunAt) <= now); }
  complete(id, { broadcastId = null, error = null }) {
    const plan = this.state.schedules.find((item) => item.id === id); if (!plan) return null;
    const completedAt = this.clock();
    plan.lastRunAt = completedAt.toISOString(); plan.lastBroadcastId = broadcastId; plan.lastError = error;
    if (plan.repeat === "ONCE") { plan.enabled = false; plan.nextRunAt = null; }
    else plan.nextRunAt = nextRunAt(plan, completedAt, this.offsetMinutes);
    plan.updatedAt = completedAt.toISOString(); this.persist(); return clone(plan);
  }
}
