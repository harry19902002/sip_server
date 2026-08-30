import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class BroadcastStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { broadcasts: [], idempotency: {} };
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) return;
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    this.state = {
      broadcasts: Array.isArray(parsed.broadcasts) ? parsed.broadcasts : [],
      idempotency: parsed.idempotency && typeof parsed.idempotency === "object" ? parsed.idempotency : {},
    };
  }

  persist() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2));
    renameSync(temporaryPath, this.filePath);
  }

  list({ state } = {}) {
    return this.state.broadcasts
      .filter((broadcast) => !state || broadcast.state === state)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((broadcast) => structuredClone(broadcast));
  }

  get(id) {
    const broadcast = this.state.broadcasts.find((item) => item.id === id);
    return broadcast ? structuredClone(broadcast) : null;
  }

  getByIdempotencyKey(key) {
    if (!key) return null;
    const id = this.state.idempotency[key];
    return id ? this.get(id) : null;
  }

  create(broadcast, idempotencyKey) {
    this.state.broadcasts.push(structuredClone(broadcast));
    if (idempotencyKey) this.state.idempotency[idempotencyKey] = broadcast.id;
    this.persist();
    return this.get(broadcast.id);
  }

  update(id, mutate) {
    const index = this.state.broadcasts.findIndex((item) => item.id === id);
    if (index < 0) return null;
    mutate(this.state.broadcasts[index]);
    this.state.broadcasts[index].updatedAt = new Date().toISOString();
    this.persist();
    return this.get(id);
  }

  updateTarget(broadcastId, targetId, mutate) {
    return this.update(broadcastId, (broadcast) => {
      const target = broadcast.targets.find((item) => item.id === targetId);
      if (target) mutate(target, broadcast);
    });
  }

  findTargetByJobUuid(jobUuid) {
    for (const broadcast of this.state.broadcasts) {
      const target = broadcast.targets.find((item) => item.jobUuid === jobUuid);
      if (target) return { broadcastId: broadcast.id, targetId: target.id };
    }
    return null;
  }
}
