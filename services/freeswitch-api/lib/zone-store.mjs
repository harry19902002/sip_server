import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }

// ---------- 分区号码 ----------
//
// 分区号码用于「拨打号码 → 对分区内所有终端群呼」，因此必须：
//   1. 与普通分机号段区分开，避免误拨到个人；
//   2. 与该 FreeSWITCH 实例实际加载的 dialplan 不冲突。
//
// 号段选择 6xxxx（5 位，60000~69999）：
//   - 与个人分机号段（4 位，1000~1005）位数不同、前缀不同，天然不冲突；
//   - 实测随包 dialplan 的 6 开头规则只有 **4 位** 的 6000 与 60xx
//     （default.xml 第 549/561 行，第 549 行是 conference 演示，
//      第 561 行是 `^((?!6000)60\d{2})$`），与 5 位 6xxxx **不重叠**；
//   - 原先用的 9xxx 号段与随包样例大量冲突（9000/9001/9170~9198/9386/9664），
//     改用 6xxxx 可彻底避开这些占用。
//   起始值取 60000，自动分配时按序递增便于人工记忆。
export const ZONE_NUMBER_MIN = 60000;
export const ZONE_NUMBER_MAX = 69999;

// 仍保留一份显式黑名单，防止将来更换 FreeSWITCH 样例版本后重新引入冲突。
// 收录「与 6xxxx 可能产生歧义」的已知号码；当前实测为空——
// 随包 dialplan 未占用任何 5 位 6 开头号码。
const RESERVED_ZONE_NUMBERS = new Set([]);

const numberPattern = /^[0-9]{5}$/;

function normalizeNumber(value) {
  const number = String(value ?? "").trim();
  if (!numberPattern.test(number)) throw problem("分区号码必须是 5 位数字");
  const numeric = Number(number);
  if (numeric < ZONE_NUMBER_MIN || numeric > ZONE_NUMBER_MAX) {
    throw problem(`分区号码需在 ${ZONE_NUMBER_MIN}-${ZONE_NUMBER_MAX} 之间（6 开头 5 位号段）`);
  }
  if (RESERVED_ZONE_NUMBERS.has(number)) {
    throw problem(`号码 ${number} 与 FreeSWITCH 内置拨号方案冲突，请换一个`);
  }
  return number;
}

/** 判断号码是否属于当前号段（用于识别需要迁移的存量号码）。 */
function isCurrentSegment(number) {
  if (!numberPattern.test(String(number ?? ""))) return false;
  const numeric = Number(number);
  return numeric >= ZONE_NUMBER_MIN && numeric <= ZONE_NUMBER_MAX && !RESERVED_ZONE_NUMBERS.has(String(number));
}

export class ZoneStore {
  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { zones: [], assignments: {} };
    if (!Array.isArray(this.state.zones)) this.state.zones = [];
    if (!this.state.assignments || typeof this.state.assignments !== "object") this.state.assignments = {};
    // 兼容旧数据：为没有号码的分区补一个，保证「拨打分区号」对存量分区同样可用。
    if (this.ensureNumbers()) this.persist();
  }

  persist() { const temporary = `${this.file}.tmp`; writeFileSync(temporary, JSON.stringify(this.state, null, 2)); renameSync(temporary, this.file); }

  /**
   * 重新从磁盘加载。
   * 供备份导入 / 恢复出厂设置使用：这些操作直接改了磁盘文件，
   * 若不刷新内存，界面仍显示旧分区，且下次写操作会把旧数据覆盖回去。
   * 必须复用构造函数里的规范化逻辑（补号码、补默认字段），否则
   * 把一个手工编辑过的 zones.json 导入后会留下无号码的分区。
   */
  reload() {
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { zones: [], assignments: {} };
    if (!Array.isArray(this.state.zones)) this.state.zones = [];
    if (!this.state.assignments || typeof this.state.assignments !== "object") this.state.assignments = {};
    if (this.ensureNumbers()) this.persist();
    return this;
  }

  /** 已占用的号码集合（含显式指定与自动分配）。 */
  usedNumbers() {
    return new Set(this.state.zones.map((zone) => zone.number).filter(Boolean));
  }

  /**
   * 为缺少号码的分区分配号码，并把**旧号段**的号码迁移到当前号段。
   *
   * 迁移场景：早期版本用 9xxx（4 位），现改为 6xxxx（5 位）。
   * 旧号段既与样例 dialplan 冲突、又已废弃，因此在加载时统一重分配，
   * 否则存量分区会继续用旧号（拨号可能被样例抢先匹配）。
   * 返回是否有改动（供构造函数决定是否落盘）。
   */
  ensureNumbers() {
    let changed = false;
    for (const zone of this.state.zones) {
      if (zone.number && isCurrentSegment(zone.number)) continue;
      const previous = zone.number;
      const number = this.pickFreeNumber(zone.id);
      if (!number) break; // 号段耗尽，留待用户手工处理
      zone.number = number;
      zone.previousNumber = previous || null;
      changed = true;
    }
    return changed;
  }

  /** 从号段中挑一个未占用、且不与样例拨号方案冲突的号码。 */
  pickFreeNumber(excludeId = null) {
    const used = new Set(this.state.zones.filter((zone) => zone.id !== excludeId).map((zone) => zone.number).filter(Boolean));
    for (let candidate = ZONE_NUMBER_MIN; candidate <= ZONE_NUMBER_MAX; candidate += 1) {
      const number = String(candidate);
      if (RESERVED_ZONE_NUMBERS.has(number)) continue;
      if (!used.has(number)) return number;
    }
    return null;
  }

  /** 校验号码可用性；重复占用已存在号码时抛 409。 */
  assertNumberAvailable(number, excludeId = null) {
    const conflict = this.state.zones.find((zone) => zone.number === number && zone.id !== excludeId);
    if (conflict) throw problem(`号码 ${number} 已被分区「${conflict.name}」占用`, 409);
  }

  list() { return this.state.zones.map((zone) => ({ ...zone, terminalIds: Object.entries(this.state.assignments).filter(([, zoneId]) => zoneId === zone.id).map(([terminalId]) => terminalId) })); }
  terminalZones() { const names = new Map(this.state.zones.map((zone) => [zone.id, zone.name])); return Object.fromEntries(Object.entries(this.state.assignments).map(([terminalId, zoneId]) => [terminalId, names.get(zoneId) || "未分配"])); }

  create(input) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 40) throw problem("zone name must contain 1-40 characters");
    if (this.state.zones.some((zone) => zone.name.toLowerCase() === name.toLowerCase())) throw problem("zone name already exists", 409);
    // 未指定号码则自动分配；指定则按规则校验
    let number;
    if (input.number === undefined || input.number === null || String(input.number).trim() === "") {
      number = this.pickFreeNumber();
      if (!number) throw problem("9 号段已无可用号码，请先释放部分分区号码");
    } else {
      number = normalizeNumber(input.number);
      this.assertNumberAvailable(number);
    }
    const zone = { id: randomUUID(), name, number, createdAt: new Date().toISOString() };
    this.state.zones.push(zone); this.persist(); return { ...zone, terminalIds: [] };
  }

  /**
   * 更新分区：名称与号码都可改。
   * 号码改动会直接影响「拨打哪个号码群呼」，因此必须做唯一性校验。
   */
  update(id, input) {
    const zone = this.state.zones.find((item) => item.id === id); if (!zone) throw problem("zone not found", 404);

    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name || name.length > 40) throw problem("zone name must contain 1-40 characters");
      if (this.state.zones.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) throw problem("zone name already exists", 409);
      zone.name = name;
    }

    if (input.number !== undefined) {
      const number = normalizeNumber(input.number);
      this.assertNumberAvailable(number, id);
      zone.number = number;
    }

    this.persist(); return this.list().find((item) => item.id === id);
  }

  /** 仅改名的便捷方法（保留原有调用方兼容）。 */
  rename(id, input) { return this.update(id, input); }

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

  /** 供 dialplan 渲染使用：号码 → { name, extensions[] }。 */
  dialplanZones() {
    const extensionOf = (terminalId) => String(terminalId).split("@")[0];
    return this.list()
      .filter((zone) => zone.number)
      .map((zone) => ({
        number: zone.number,
        name: zone.name,
        extensions: [...new Set(zone.terminalIds.map(extensionOf).filter((item) => /^\d{2,12}$/.test(item)))],
      }));
  }
}
