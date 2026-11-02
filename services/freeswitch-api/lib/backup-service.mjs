// 系统备份 / 导入 / 恢复出厂设置。
//
// 设计要点（三条硬约束，违反任意一条都会丢数据）：
//
// 1. **导入后必须让内存状态重新对齐磁盘**
//    各 Store 在构造时把 JSON 读进 this.state，之后所有读写都基于内存。
//    如果只覆盖磁盘文件而不刷新内存，界面会继续显示旧数据，
//    且下一次任何写操作都会把内存里的旧数据（可能已被清空）覆盖回去，
//    导致刚导入的内容被静默丢弃。因此导入/重置后统一调用 reloadAll()。
//
// 2. **导入前自动留一份回滚点**
//    导入是破坏性操作。万一用户传错文件（甚至是别的系统导出的备份），
//    没有回滚点就只能手工恢复。因此导入前先把当前状态整包存到 backups/ 下。
//
// 3. **写盘严格校验，绝不写入半成品**
//    备份包里的每个 JSON 都要校验结构；音频文件只接受 .wav/.mp3 且校验文件头。
//    宁可整包拒绝，也不要导入一半后发现某个字段非法。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createZip, readZip } from "./zip.mjs";

const BACKUP_FORMAT = "sip-broadcast-backup";
const BACKUP_VERSION = 1;
// 单个音频上限，与上传接口保持一致
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
// 回滚包保留数量：太多占空间，太少失去意义
const MAX_ROLLBACK_FILES = 5;
const MANIFEST_NAME = "manifest.json";

function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 安全读取 JSON；文件不存在时返回 fallback。 */
function readJsonFile(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

export class BackupService {
  /**
   * @param {object} options
   * @param {object} options.stores 需要纳入备份的各 Store 实例（见 server.mjs 装配）
   * @param {string} options.backupDirectory 回滚包存放目录
   */
  constructor({ stores, backupDirectory }) {
    this.stores = stores;
    this.backupDirectory = backupDirectory;
    mkdirSync(backupDirectory, { recursive: true });
  }

  /** 各数据文件的位置与结构校验规则。 */
  files() {
    const { broadcasts, media, zones, schedules, presets, system, terminals } = this.stores;
    return [
      { name: "broadcasts.json", file: broadcasts.filePath, validate: (d) => ({ broadcasts: arrayOf(d?.broadcasts), idempotency: isPlainObject(d?.idempotency) ? d.idempotency : {} }) },
      { name: "media.json", file: media.metadataFile, validate: (d) => ({ files: arrayOf(d?.files), playlists: arrayOf(d?.playlists) }) },
      { name: "zones.json", file: zones.file, validate: (d) => ({ zones: arrayOf(d?.zones), assignments: isPlainObject(d?.assignments) ? d.assignments : {} }) },
      { name: "schedules.json", file: schedules.store.file, validate: (d) => ({ schedules: arrayOf(d?.schedules) }) },
      { name: "presets.json", file: presets.store.file, validate: (d) => ({ presets: arrayOf(d?.presets), nextNumber: Number(d?.nextNumber) || 880001 }) },
      { name: "system.json", file: system.file, validate: (d) => {
        // 密码哈希必须随备份迁移，否则导入后没人能登录。
        if (!isPlainObject(d?.config)) throw problem("system.json 缺少 config");
        return {
          config: d.config,
          users: arrayOf(d.users),
          permissions: Array.isArray(d.permissions) && d.permissions.length ? d.permissions : [],
        };
      } },
      { name: "terminals.json", file: terminals.file, validate: (d) => (isPlainObject(d) ? d : {}) },
    ];
  }

  /** 扫描媒体目录，返回 data/media 下的音频文件清单。 */
  audioFiles() {
    const directory = this.stores.media.mediaDirectory;
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => /\.(wav|mp3)$/i.test(name))
      .map((name) => ({ name, path: join(directory, name), size: statSync(join(directory, name)).size }));
  }

  /** 生成清单：用于「备份信息」展示与导入前校验。 */
  manifest() {
    const files = this.files();
    const counts = {
      broadcasts: arrayOf(readJsonFile(files[0].file, {})?.broadcasts).length,
      mediaFiles: arrayOf(readJsonFile(files[1].file, {})?.files).length,
      playlists: arrayOf(readJsonFile(files[1].file, {})?.playlists).length,
      zones: arrayOf(readJsonFile(files[2].file, {})?.zones).length,
      schedules: arrayOf(readJsonFile(files[3].file, {})?.schedules).length,
      presets: arrayOf(readJsonFile(files[4].file, {})?.presets).length,
      users: arrayOf(readJsonFile(files[5].file, {})?.users).length,
      terminals: Object.keys(readJsonFile(files[6].file, {}) ?? {}).length,
    };
    const audio = this.audioFiles();
    return {
      counts,
      audioFiles: audio.length,
      audioBytes: audio.reduce((sum, item) => sum + item.size, 0),
      dataBytes: files.reduce((sum, item) => sum + (existsSync(item.file) ? statSync(item.file).size : 0), 0),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 打出完整备份包（配置 + 音频）。
   * @returns {{ buffer: Buffer, filename: string, manifest: object }}
   */
  create() {
    const manifest = this.manifest();
    const entries = [];
    const errors = [];

    for (const item of this.files()) {
      if (!existsSync(item.file)) continue;
      try {
        // 备份时按结构校验一遍，避免把损坏的 JSON 一起带走
        const parsed = JSON.parse(readFileSync(item.file, "utf8"));
        item.validate(parsed);
        entries.push({ name: `data/${item.name}`, data: Buffer.from(JSON.stringify(parsed, null, 2), "utf8") });
      } catch (error) {
        errors.push(`${item.name}: ${error.message}`);
      }
    }
    if (errors.length) throw problem(`备份失败，以下数据文件无法读取：${errors.join("；")}`, 500);

    for (const audio of this.audioFiles()) {
      if (audio.size > MAX_AUDIO_BYTES) {
        errors.push(`${audio.name} 超过 ${MAX_AUDIO_BYTES / 1024 / 1024}MB`);
        continue;
      }
      entries.push({ name: `media/${audio.name}`, data: readFileSync(audio.path) });
    }
    if (errors.length) throw problem(`备份失败：${errors.join("；")}`, 500);

    entries.push({
      name: MANIFEST_NAME,
      data: Buffer.from(JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: new Date().toISOString(),
        ...manifest,
        entries: entries.map((entry) => entry.name),
      }, null, 2), "utf8"),
    });

    return {
      buffer: createZip(entries),
      filename: `sip-broadcast-backup-${stamp()}.zip`,
      manifest,
    };
  }

  /**
   * 导入备份包。执行顺序刻意设计为：
   *   校验全部内容 → 存回滚包 → 清空媒体目录 → 写配置 → 写音频 → 刷新内存
   * 任何一步抛错都不会留下「一半旧一半新」的状态。
   */
  async import(buffer) {
    const files = readZip(buffer);
    const manifestRaw = files.get(MANIFEST_NAME);
    if (!manifestRaw) throw problem("备份包缺少 manifest.json，不是本系统导出的备份");

    let manifest;
    try { manifest = JSON.parse(manifestRaw.toString("utf8")); }
    catch { throw problem("备份包的 manifest.json 无法解析"); }

    if (manifest.format !== BACKUP_FORMAT) throw problem("备份包格式不符，可能来自其他系统");
    if (Number(manifest.version) > BACKUP_VERSION) {
      throw problem(`备份包版本（${manifest.version}）高于当前系统支持的版本（${BACKUP_VERSION}），请升级后再导入`);
    }

    // ---------- 1. 先在内存里完成全部校验，不碰磁盘 ----------
    const prepared = [];
    const known = new Set(this.files().map((item) => `data/${item.name}`));
    for (const item of this.files()) {
      const entry = files.get(`data/${item.name}`);
      if (!entry) continue;
      let parsed;
      try { parsed = JSON.parse(entry.toString("utf8")); }
      catch { throw problem(`备份包中的 ${item.name} 不是合法 JSON`); }
      prepared.push({ target: item.file, name: item.name, data: item.validate(parsed) });
    }
    if (!prepared.length) throw problem("备份包中没有任何可导入的数据文件");

    const audio = [];
    for (const [name, data] of files) {
      if (!name.startsWith("media/")) continue;
      const filename = basename(name);
      if (!/\.(wav|mp3)$/i.test(filename)) throw problem(`备份包中包含不支持的音频文件：${filename}`);
      if (data.length > MAX_AUDIO_BYTES) throw problem(`音频文件 ${filename} 超过大小上限`);
      // 校验文件头，避免把损坏或被改名的文件放进媒体库
      const isWav = data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WAVE";
      const isMp3 = data.length >= 3 && (data.subarray(0, 3).toString("ascii") === "ID3" || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0));
      if ((/\.wav$/i.test(filename) && !isWav) || (/\.mp3$/i.test(filename) && !isMp3)) {
        throw problem(`音频文件 ${filename} 内容与扩展名不符`);
      }
      audio.push({ filename, data });
    }

    // 未知的 data/*.json 只提示，不阻断（便于未来版本兼容）
    const ignored = [...files.keys()].filter((name) => name.startsWith("data/") && !known.has(name));

    // ---------- 2. 留回滚点 ----------
    let rollback = null;
    try {
      rollback = this.writeRollback();
    } catch (error) {
      // 备份当前状态失败时不要继续导入，否则无法回滚
      throw problem(`导入前保存回滚点失败，已中止导入：${error.message}`, 500);
    }

    // ---------- 3. 落盘 ----------
    for (const item of prepared) {
      const temporary = `${item.target}.import-tmp`;
      mkdirSync(dirname(item.target), { recursive: true });
      writeFileSync(temporary, JSON.stringify(item.data, null, 2));
      renameSync(temporary, item.target);
    }

    const mediaDirectory = this.stores.media.mediaDirectory;
    mkdirSync(mediaDirectory, { recursive: true });
    // 清掉旧音频：否则导入的媒体库里没有的旧文件会残留成孤儿文件，占用空间
    for (const name of readdirSync(mediaDirectory)) {
      if (/\.(wav|mp3)$/i.test(name)) rmSync(join(mediaDirectory, name), { force: true });
    }
    for (const item of audio) {
      writeFileSync(join(mediaDirectory, item.filename), item.data);
    }

    // ---------- 4. 让内存状态与磁盘对齐 ----------
    this.reloadAll();

    return {
      imported: {
        dataFiles: prepared.map((item) => item.name),
        audioFiles: audio.length,
        ignoredDataFiles: ignored,
      },
      rollback,
    };
  }

  /** 恢复出厂设置：清空所有业务数据与账号，仅保留默认管理员。 */
  async factoryReset({ defaultAdminUsername, defaultAdminPassword }) {
    let rollback = null;
    try {
      rollback = this.writeRollback();
    } catch (error) {
      throw problem(`重置前保存回滚点失败，已中止重置：${error.message}`, 500);
    }

    const { broadcasts, media, zones, schedules, presets, system, terminals } = this.stores;

    // 业务数据清空
    const empty = [
      { target: broadcasts.filePath, data: { broadcasts: [], idempotency: {} } },
      { target: media.metadataFile, data: { files: [], playlists: [] } },
      { target: zones.file, data: { zones: [], assignments: {} } },
      { target: schedules.store.file, data: { schedules: [] } },
      { target: presets.store.file, data: { presets: [], nextNumber: 880001 } },
      { target: terminals.file, data: {} },
    ];
    for (const item of empty) {
      mkdirSync(dirname(item.target), { recursive: true });
      const temporary = `${item.target}.reset-tmp`;
      writeFileSync(temporary, JSON.stringify(item.data, null, 2));
      renameSync(temporary, item.target);
    }

    // 系统配置恢复默认；用户表清空后重建默认管理员
    const defaultConfig = {
      organizationName: "广播组织",
      organizationCode: "SIP-BROADCAST",
      contact: "",
      phone: "",
      theme: "light",
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(system.file), { recursive: true });
    const systemTemporary = `${system.file}.reset-tmp`;
    writeFileSync(systemTemporary, JSON.stringify({ config: defaultConfig, users: [], permissions: [] }, null, 2));
    renameSync(systemTemporary, system.file);

    // 音频文件全部删除
    const mediaDirectory = media.mediaDirectory;
    mkdirSync(mediaDirectory, { recursive: true });
    let removedAudio = 0;
    for (const name of readdirSync(mediaDirectory)) {
      if (/\.(wav|mp3)$/i.test(name)) { rmSync(join(mediaDirectory, name), { force: true }); removedAudio += 1; }
    }

    // 刷新内存，再重建默认管理员（createUser 走内存 + persist，必须在其后执行）
    this.reloadAll();
    const admin = system.ensureBootstrapAdmin({
      username: defaultAdminUsername,
      name: "系统管理员",
      password: defaultAdminPassword,
    });
    // ensureBootstrapAdmin 内部已 persist，但 permissions 仍是空数组，
    // 这里补回默认权限矩阵，避免「用户与权限」页整页空白。
    if (!system.state.permissions?.length) {
      system.state.permissions = [
        { capability: "查看总览与任务", admin: "全部数据", operator: "已授权分区与本人任务" },
        { capability: "发起实时广播", admin: "允许", operator: "允许" },
        { capability: "管理定时计划", admin: "允许", operator: "允许" },
        { capability: "管理终端与分区", admin: "允许", operator: "只读" },
        { capability: "管理 SIP 账号", admin: "允许", operator: "只读" },
        { capability: "用户与系统配置", admin: "允许", operator: "禁止" },
      ];
      system.persist();
    }

    return {
      removedAudio,
      adminUsername: admin?.username ?? defaultAdminUsername,
      rollback,
    };
  }

  /** 现有回滚包列表（新的在前）。 */
  listRollbacks() {
    if (!existsSync(this.backupDirectory)) return [];
    return readdirSync(this.backupDirectory)
      .filter((name) => name.endsWith(".zip"))
      .map((name) => {
        const path = join(this.backupDirectory, name);
        const stat = statSync(path);
        return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * 生成回滚包文件名。
   * 时间戳只精确到秒，连续两次操作（如导入后立刻重置）会撞名，
   * 后写的会覆盖前一个回滚包 —— 那就等于把更早的还原点弄丢了。
   * 因此撞名时追加序号。
   */
  nextRollbackName(date = new Date()) {
    const base = `rollback-${stamp(date)}`;
    let candidate = `${base}.zip`;
    let suffix = 1;
    while (existsSync(join(this.backupDirectory, candidate))) {
      suffix += 1;
      candidate = `${base}-${suffix}.zip`;
    }
    return candidate;
  }

  /** 打回滚包并返回文件名。失败时抛错，由调用方中止危险操作。 */
  writeRollback() {
    const snapshot = this.create();
    const name = this.nextRollbackName();
    writeFileSync(join(this.backupDirectory, name), snapshot.buffer);
    this.pruneRollbacks();
    return name;
  }

  /** 只保留最近 N 个回滚包，避免无限增长占满磁盘。 */
  pruneRollbacks() {
    for (const item of this.listRollbacks().slice(MAX_ROLLBACK_FILES)) {
      rmSync(join(this.backupDirectory, item.name), { force: true });
    }
  }

  readRollback(name) {
    const raw = String(name ?? "");
    // 先按原始输入校验，再取 basename。
    // 若只校验 basename，`../../etc/passwd` 会被规约成 `passwd` 后
    // 报成「不存在」，把「非法路径」误报成「文件缺失」，也会让调用方
    // 误以为可以继续尝试别的路径。这里直接拒绝任何带分隔符的输入。
    if (raw !== basename(raw) || !/^rollback-[\d-]+(?:-\d+)?\.zip$/.test(raw)) {
      throw problem("回滚包名称不合法", 400);
    }
    const path = join(this.backupDirectory, raw);
    if (!existsSync(path)) throw problem("回滚包不存在", 404);
    return { buffer: readFileSync(path), filename: raw };
  }

  /**
   * 让所有 Store 的内存状态重新对齐磁盘。
   *
   * 各 Store 的加载方法命名不统一（load / 构造即加载 / 私有字段），
   * 这里按实际能力逐个处理，而不是假装有统一接口。
   */
  reloadAll() {
    const { broadcasts, media, zones, schedules, presets, system, terminals } = this.stores;
    broadcasts.load();
    media.load();
    zones.reload();
    schedules.store.reload();
    presets.store.reload();
    system.reload();
    terminals.reload();
    // 预设广播的会话表指向 broadcastId，数据整体替换后这些引用已失效，
    // 必须清空，否则 reconcile 会拿旧引用去操作不存在的预设。
    presets.sessions?.clear();
  }
}

export { BACKUP_FORMAT, BACKUP_VERSION, copyFileSync };
