import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createZip, readZip, crc32 } from "../lib/zip.mjs";
import { BackupService } from "../lib/backup-service.mjs";
import { BroadcastStore } from "../lib/broadcast-store.mjs";
import { MediaStore } from "../lib/media-store.mjs";
import { ZoneStore } from "../lib/zone-store.mjs";
import { ScheduleStore } from "../lib/schedule-store.mjs";
import { PresetStore } from "../lib/preset-store.mjs";
import { SystemStore } from "../lib/system-store.mjs";
import { TerminalMetadataStore } from "../lib/terminal-metadata-store.mjs";

// ---------------------------------------------------------------- ZIP

test("zip round-trips files including binary and utf8 names", () => {
  const entries = [
    { name: "data/a.json", data: Buffer.from('{"x":1}', "utf8") },
    { name: "media/中文名.wav", data: Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]) },
    { name: "empty.txt", data: Buffer.alloc(0) },
  ];
  const zip = createZip(entries);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "应以 local header 签名开头");

  const extracted = readZip(zip);
  assert.equal(extracted.size, 3);
  assert.equal(extracted.get("data/a.json").toString("utf8"), '{"x":1}');
  assert.equal(extracted.get("media/中文名.wav").length, 12);
  assert.deepEqual([...extracted.get("media/中文名.wav").subarray(0, 4)], [...Buffer.from("RIFF")]);
  assert.equal(extracted.get("empty.txt").length, 0);
});

test("zip handles compressible and incompressible payloads", () => {
  const text = Buffer.from("A".repeat(5000), "utf8");
  const random = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 137 + 29) % 256));
  const zip = createZip([{ name: "text.txt", data: text }, { name: "rand.bin", data: random }]);
  const out = readZip(zip);
  assert.equal(out.get("text.txt").toString(), "A".repeat(5000));
  assert.deepEqual([...out.get("rand.bin")], [...random]);
  // 高度重复内容应被压缩
  assert.ok(zip.length < text.length, `压缩后应更小：${zip.length} vs ${text.length}`);
});

test("crc32 matches known values", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("zip rejects corrupted input", () => {
  assert.throws(() => readZip(Buffer.from("not a zip at all")), /不是有效的 ZIP|损坏/);
  const zip = createZip([{ name: "a.txt", data: Buffer.from("hello") }]);
  // 破坏 EOCD 签名
  const broken = Buffer.from(zip);
  broken.writeUInt32LE(0, broken.length - 22);
  assert.throws(() => readZip(broken), /损坏/);
});

test("zip rejects empty entry list", () => {
  assert.throws(() => createZip([]), /至少需要包含一个文件/);
});

// ---------------------------------------------------------------- 夹具

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "backup-test-"));
  const dataDir = join(root, "data");
  const mediaDir = join(dataDir, "media");
  mkdirSync(mediaDir, { recursive: true });

  const stores = {
    broadcasts: new BroadcastStore(join(dataDir, "broadcasts.json")),
    media: new MediaStore({ metadataFile: join(dataDir, "media.json"), mediaDirectory: mediaDir, freeswitchPrefix: mediaDir.replace(/\\/g, "/") }),
    zones: new ZoneStore(join(dataDir, "zones.json")),
    schedules: { store: new ScheduleStore(join(dataDir, "schedules.json")) },
    presets: { store: new PresetStore(join(dataDir, "presets.json")), sessions: new Map() },
    system: new SystemStore(join(dataDir, "system.json")),
    terminals: new TerminalMetadataStore(join(dataDir, "terminals.json")),
  };
  const service = new BackupService({ stores, backupDirectory: join(dataDir, "backups") });
  return { root, dataDir, mediaDir, stores, service };
}

function wav(seed = 1) {
  const data = Buffer.alloc(2000);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * seed) % 256;
  const header = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  return Buffer.concat([header, data]);
}

function seedData(f) {
  const { stores, mediaDir } = f;
  stores.system.ensureBootstrapAdmin({ username: "admin", name: "管理员", password: "secret123" });
  stores.system.updateConfig({ organizationName: "备份测试组织", organizationCode: "BACKUP-T", contact: "张三", phone: "123", theme: "dark" });

  const audio = wav(7);
  writeFileSync(join(mediaDir, "audio-1.wav"), audio);
  const zone = stores.zones.create({ name: "一楼" });
  stores.zones.assign(zone.id, ["1000@sip.local"]);
  stores.terminals.rename("1000@sip.local", { name: "大厅音箱" });
  stores.schedules.store.create({ name: "晨间", mediaFileId: "m1", zoneIds: [zone.id], repeat: "DAILY", date: "2026-08-31", time: "09:00" });
  return { audio, zone };
}

// ---------------------------------------------------------------- 备份

test("create() packages config + audio and a manifest", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);

  const result = f.service.create();
  assert.match(result.filename, /^sip-broadcast-backup-[\d-]+\.zip$/);
  assert.equal(result.manifest.audioFiles, 1);

  const files = readZip(result.buffer);
  assert.ok(files.has("manifest.json"));
  assert.ok(files.has("data/system.json"));
  assert.ok(files.has("data/zones.json"));
  assert.ok(files.has("media/audio-1.wav"), "音频应被打包");

  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  assert.equal(manifest.format, "sip-broadcast-backup");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.counts.users, 1);
  assert.equal(manifest.counts.zones, 1);
  assert.equal(manifest.counts.schedules, 1);
});

test("backup includes password hash so users can log in after restore", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);
  const files = readZip(f.service.create().buffer);
  const system = JSON.parse(files.get("data/system.json").toString("utf8"));
  assert.equal(system.users.length, 1);
  assert.match(system.users[0].passwordHash, /^scrypt\$/, "必须带上密码哈希");
});

// ---------------------------------------------------------------- 导入

test("import replaces data and refreshes in-memory state", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const { zone } = seedData(f);
  const backupBuffer = f.service.create().buffer;

  // 改动现场：删分区、改组织名、删音频
  f.stores.zones.delete(zone.id);
  f.stores.system.updateConfig({ organizationName: "被改坏了", organizationCode: "BROKEN", theme: "light" });
  rmSync(join(f.mediaDir, "audio-1.wav"), { force: true });

  assert.equal(f.stores.zones.list().length, 0);
  assert.equal(f.stores.system.getConfig().organizationName, "被改坏了");

  const result = await f.service.import(backupBuffer);
  assert.ok(result.imported.audioFiles === 1);
  assert.ok(result.rollback, "应生成回滚包");

  // 关键：内存状态必须已同步（而不是只改了磁盘）
  assert.equal(f.stores.zones.list().length, 1, "内存中分区应被恢复");
  assert.equal(f.stores.zones.list()[0].name, "一楼");
  assert.equal(f.stores.system.getConfig().organizationName, "备份测试组织");
  assert.equal(f.stores.system.getConfig().theme, "dark");
  assert.equal(f.stores.schedules.store.list().length, 1);
  assert.ok(existsSync(join(f.mediaDir, "audio-1.wav")), "音频应被还原");
});

test("imported data survives the next write (no stale overwrite)", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const { zone } = seedData(f);
  const backupBuffer = f.service.create().buffer;

  f.stores.zones.delete(zone.id);
  await f.service.import(backupBuffer);

  // 导入后做一次写操作：如果内存没刷新，这里会把空数据写回磁盘
  f.stores.zones.create({ name: "新分区" });
  const onDisk = JSON.parse(readFileSync(join(f.dataDir, "zones.json"), "utf8"));
  assert.equal(onDisk.zones.length, 2, `磁盘应保留导入的 1 个 + 新增的 1 个，实际 ${onDisk.zones.length}`);
  assert.ok(onDisk.zones.some((item) => item.name === "一楼"), "导入的分区不应被覆盖丢失");
});

test("import removes orphan audio not present in the backup", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);
  const backupBuffer = f.service.create().buffer;

  writeFileSync(join(f.mediaDir, "orphan.wav"), wav(3));
  await f.service.import(backupBuffer);

  const remaining = readdirSync(f.mediaDir).filter((n) => /\.(wav|mp3)$/i.test(n));
  assert.deepEqual(remaining, ["audio-1.wav"], `应只剩备份中的音频，实际 ${remaining.join(",")}`);
});

test("import rejects non-backup files without touching data", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);
  const before = readFileSync(join(f.dataDir, "zones.json"), "utf8");

  await assert.rejects(() => f.service.import(createZip([{ name: "readme.txt", data: Buffer.from("hi") }])), /manifest/);
  assert.equal(readFileSync(join(f.dataDir, "zones.json"), "utf8"), before, "拒绝导入时不应改动数据");
});

test("import rejects mismatched format and newer version", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);

  const wrongFormat = createZip([{ name: "manifest.json", data: Buffer.from(JSON.stringify({ format: "other-app", version: 1 })) }]);
  await assert.rejects(() => f.service.import(wrongFormat), /格式不符/);

  const newer = createZip([{ name: "manifest.json", data: Buffer.from(JSON.stringify({ format: "sip-broadcast-backup", version: 99 })) }]);
  await assert.rejects(() => f.service.import(newer), /高于当前系统支持的版本/);
});

test("import rejects audio whose content does not match extension", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);

  const manifest = { format: "sip-broadcast-backup", version: 1 };
  const bad = createZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "data/zones.json", data: Buffer.from(JSON.stringify({ zones: [], assignments: {} })) },
    { name: "media/fake.wav", data: Buffer.from("this is definitely not a wav file") },
  ]);
  await assert.rejects(() => f.service.import(bad), /内容与扩展名不符/);
});

test("import rejects unsupported audio extension", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);
  const bad = createZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify({ format: "sip-broadcast-backup", version: 1 })) },
    { name: "data/zones.json", data: Buffer.from(JSON.stringify({ zones: [], assignments: {} })) },
    { name: "media/evil.exe", data: Buffer.from("MZ") },
  ]);
  await assert.rejects(() => f.service.import(bad), /不支持的音频文件/);
});

// ---------------------------------------------------------------- 恢复出厂

test("factory reset clears business data but keeps a working admin", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);

  const result = await f.service.factoryReset({ defaultAdminUsername: "admin", defaultAdminPassword: "newpass123" });
  assert.equal(result.adminUsername, "admin");

  assert.equal(f.stores.zones.list().length, 0);
  assert.equal(f.stores.schedules.store.list().length, 0);
  assert.equal(f.stores.broadcasts.list().length, 0);
  assert.equal(f.stores.media.listFiles().length, 0);
  assert.equal(readdirSync(f.mediaDir).filter((n) => /\.(wav|mp3)$/i.test(n)).length, 0);

  // 组织信息回落默认
  assert.equal(f.stores.system.getConfig().organizationName, "广播组织");

  // 关键：重置后必须还能登录，否则系统就锁死了
  const user = f.stores.system.authenticate("admin", "newpass123");
  assert.ok(user, "重置后应能用默认管理员登录");
  assert.equal(user.role, "系统管理员");
  assert.ok(f.stores.system.permissions().length > 0, "权限矩阵不应为空");
});

test("factory reset writes a rollback package first", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);
  const result = await f.service.factoryReset({ defaultAdminUsername: "admin", defaultAdminPassword: "newpass123" });
  assert.ok(result.rollback, "重置前应留回滚包");
  const rollbacks = f.service.listRollbacks();
  assert.ok(rollbacks.length >= 1);
  assert.ok(rollbacks.some((item) => item.name === result.rollback));
});

test("rollback packages are pruned to the newest five", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);
  // 直接造 8 个回滚包，触发裁剪
  for (let i = 0; i < 8; i += 1) {
    writeFileSync(join(f.dataDir, "backups", `rollback-2026010${i}-120000.zip`), f.service.create().buffer);
  }
  f.service.pruneRollbacks();
  assert.equal(f.service.listRollbacks().length, 5, "应只保留最近 5 个");
});

test("rollback names do not collide within the same second", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);
  // 连续两次操作很容易落在同一秒，若撞名则后写的会覆盖先写的，
  // 等于丢掉更早的还原点
  const first = f.service.writeRollback();
  const second = f.service.writeRollback();
  assert.notEqual(first, second, `两次回滚包不应同名：${first}`);
  assert.equal(f.service.listRollbacks().length, 2);
  // 带序号的名称也要能被读回
  assert.ok(f.service.readRollback(second).buffer.length > 0);
});

test("readRollback accepts the suffixed name format", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);
  const first = f.service.writeRollback();
  const second = f.service.writeRollback();
  assert.match(second, /^rollback-[\d-]+-\d+\.zip$/, `带序号格式：${second}`);
  assert.ok(f.service.readRollback(second).buffer.length > 0);
  assert.ok(f.service.readRollback(first).buffer.length > 0);
});

test("readRollback rejects path traversal and malformed names", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  // 路径穿越：basename 后仍会变成 passwd，必须在规约前就拒绝
  assert.throws(() => f.service.readRollback("../../etc/passwd"), /名称不合法/);
  assert.throws(() => f.service.readRollback("..\\..\\win.ini"), /名称不合法/);
  // 名称格式不符（非 rollback-* 前缀）
  assert.throws(() => f.service.readRollback("evil.zip"), /名称不合法/);
  assert.throws(() => f.service.readRollback("rollback-x.zip"), /名称不合法/);
  // 格式合法但文件不存在 → 404，而不是 400
  assert.throws(() => f.service.readRollback("rollback-1.zip"), /不存在/);
});

// ---------------------------------------------------------------- manifest

test("manifest reports current counts", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  seedData(f);
  const m = f.service.manifest();
  assert.equal(m.counts.zones, 1);
  assert.equal(m.counts.users, 1);
  assert.equal(m.counts.schedules, 1);
  assert.equal(m.counts.terminals, 1);
  assert.equal(m.audioFiles, 1);
  assert.ok(m.audioBytes > 0);
  assert.ok(m.dataBytes >= 0);
});
