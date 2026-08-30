import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const repeats = new Set(["ONCE", "DAILY", "WEEKDAYS", "WEEKLY"]);

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
  const mediaFileId = String(input.mediaFileId ?? "");
  const zoneIds = Array.isArray(input.zoneIds) ? [...new Set(input.zoneIds.map(String))] : [];
  const repeat = String(input.repeat ?? "ONCE");
  const date = String(input.date ?? "");
  const time = String(input.time ?? "");
  const volume = Number(input.volume ?? 75);
  if (!name || name.length > 100) throw problem("name must contain 1-100 characters");
  if (!mediaFileId) throw problem("mediaFileId is required");
  if (!zoneIds.length) throw problem("zoneIds must contain at least one zone");
  if (!repeats.has(repeat)) throw problem("repeat must be ONCE, DAILY, WEEKDAYS, or WEEKLY");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw problem("date must be a valid YYYY-MM-DD date");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw problem("time must use HH:mm");
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw problem("volume must be an integer from 0 to 100");
  return { name, mediaFileId, zoneIds, repeat, date, time, volume };
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
    Object.assign(plan, values, { enabled, nextRunAt: enabled ? nextRunAt(values, this.clock(), this.offsetMinutes) : null, updatedAt: this.clock().toISOString() });
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
