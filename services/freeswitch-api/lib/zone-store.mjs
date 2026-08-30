import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }

export class ZoneStore {
  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { zones: [], assignments: {} };
    if (!Array.isArray(this.state.zones)) this.state.zones = [];
    if (!this.state.assignments || typeof this.state.assignments !== "object") this.state.assignments = {};
  }
  persist() { const temporary = `${this.file}.tmp`; writeFileSync(temporary, JSON.stringify(this.state, null, 2)); renameSync(temporary, this.file); }
  list() { return this.state.zones.map((zone) => ({ ...zone, terminalIds: Object.entries(this.state.assignments).filter(([, zoneId]) => zoneId === zone.id).map(([terminalId]) => terminalId) })); }
  terminalZones() { const names = new Map(this.state.zones.map((zone) => [zone.id, zone.name])); return Object.fromEntries(Object.entries(this.state.assignments).map(([terminalId, zoneId]) => [terminalId, names.get(zoneId) || "未分配"])); }
  create(input) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 40) throw problem("zone name must contain 1-40 characters");
    if (this.state.zones.some((zone) => zone.name.toLowerCase() === name.toLowerCase())) throw problem("zone name already exists", 409);
    const zone = { id: randomUUID(), name, createdAt: new Date().toISOString() }; this.state.zones.push(zone); this.persist(); return { ...zone, terminalIds: [] };
  }
  rename(id, input) {
    const zone = this.state.zones.find((item) => item.id === id); if (!zone) throw problem("zone not found", 404);
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 40) throw problem("zone name must contain 1-40 characters");
    if (this.state.zones.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) throw problem("zone name already exists", 409);
    zone.name = name; this.persist(); return this.list().find((item) => item.id === id);
  }
  assign(id, terminalIds) {
    if (!this.state.zones.some((zone) => zone.id === id)) throw problem("zone not found", 404);
    if (!Array.isArray(terminalIds) || terminalIds.some((item) => typeof item !== "string" || !item.trim())) throw problem("terminalIds must be an array of terminal ids");
    for (const [terminalId, zoneId] of Object.entries(this.state.assignments)) if (zoneId === id) delete this.state.assignments[terminalId];
    for (const terminalId of new Set(terminalIds)) this.state.assignments[terminalId] = id;
    this.persist(); return this.list().find((item) => item.id === id);
  }
  delete(id) {
    const index = this.state.zones.findIndex((zone) => zone.id === id); if (index < 0) throw problem("zone not found", 404);
    const [zone] = this.state.zones.splice(index, 1);
    for (const [terminalId, zoneId] of Object.entries(this.state.assignments)) if (zoneId === id) delete this.state.assignments[terminalId];
    this.persist(); return zone;
  }
}
