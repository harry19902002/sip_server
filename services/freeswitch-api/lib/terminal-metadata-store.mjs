import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export class TerminalMetadataStore {
  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.load();
  }

  /** 载入。构造函数与 reload() 共用。 */
  load() {
    this.names = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    return this;
  }

  /** 重新从磁盘加载（备份导入 / 恢复出厂设置后同步内存状态）。 */
  reload() { return this.load(); }

  listNames() {
    return { ...this.names };
  }

  rename(id, input) {
    const terminalId = String(id ?? "").trim();
    const name = String(input.name ?? "").trim();
    if (!terminalId || terminalId.length > 160) throw problem("terminal id is invalid");
    if (!name || name.length > 80) throw problem("terminal name must contain 1-80 characters");
    this.names[terminalId] = name;
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.names, null, 2));
    renameSync(temporary, this.file);
    return { id: terminalId, name };
  }
}
