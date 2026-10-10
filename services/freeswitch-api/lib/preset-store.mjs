import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }

export function validatePreset(input) {
  const name = String(input.name ?? "").trim();
  const zoneIds = Array.isArray(input.zoneIds) ? [...new Set(input.zoneIds.map(String))] : [];
  const sources = Array.isArray(input.sources) ? input.sources.map((item) => ({ type: item?.type, id: String(item?.id ?? "") })) : [];
  const volume = Number(input.volume ?? 75);
  const playMode = String(input.playMode ?? "ONCE").toUpperCase();
  if (!name || name.length > 100) throw problem("预设名称需要填写 1-100 个字符");
  if (!zoneIds.length || zoneIds.length > 500) throw problem("请选择 1-500 个广播分区");
  if (!sources.length || sources.length > 50 || sources.some((item) => !["FILE", "PLAYLIST"].includes(item.type) || !item.id)) throw problem("请选择 1-50 项音频文件或播放列表");
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw problem("音量必须是 0-100 的整数");
  if (!["ONCE", "LOOP", "SHUFFLE"].includes(playMode)) throw problem("播放模式不正确");
  return { name, zoneIds, sources, volume, playMode };
}

export class PresetStore {
  constructor(file, { numberAvailable = () => true } = {}) {
    this.file = file;
    this.numberAvailable = numberAvailable;
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { presets: [], nextNumber: 880001 };
    this.state.presets ??= [];
    // Numbers are never reused, so a deleted preset's number cannot trigger another preset.
    this.state.nextNumber ??= Math.max(880000, ...this.state.presets.map((item) => Number(item.sipNumber))) + 1;
  }
  persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2));
    renameSync(temporary, this.file);
  }
  list() { return this.state.presets.map((item) => structuredClone(item)); }
  get(id) { const preset = this.state.presets.find((item) => item.id === id); return preset ? structuredClone(preset) : null; }
  byNumber(number) { return this.list().find((item) => item.sipNumber === number) ?? null; }
  create(input) {
    const values = validatePreset(input);
    while (this.state.nextNumber <= 889999 && !this.numberAvailable(String(this.state.nextNumber))) this.state.nextNumber++;
    if (this.state.nextNumber > 889999) throw problem("预设广播号码已分配完毕", 409);
    const now = new Date().toISOString();
    const preset = { id: randomUUID(), ...values, sipNumber: String(this.state.nextNumber++), createdAt: now, updatedAt: now };
    this.state.presets.push(preset); this.persist(); return structuredClone(preset);
  }
  update(id, input) {
    const preset = this.state.presets.find((item) => item.id === id);
    if (!preset) throw problem("预设广播不存在", 404);
    Object.assign(preset, validatePreset({ ...preset, ...input }), { updatedAt: new Date().toISOString() });
    this.persist(); return structuredClone(preset);
  }
  delete(id) {
    const index = this.state.presets.findIndex((item) => item.id === id);
    if (index < 0) throw problem("预设广播不存在", 404);
    const [preset] = this.state.presets.splice(index, 1); this.persist(); return structuredClone(preset);
  }
}
