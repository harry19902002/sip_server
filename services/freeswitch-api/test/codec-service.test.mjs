import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CODEC_CATALOG, CodecService, DEFAULT_CODEC_PREFS, normalizeCodecPrefs } from "../lib/codec-service.mjs";
import { SystemStore } from "../lib/system-store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function tempStore() {
  return new SystemStore(join(mkdtempSync(join(tmpdir(), "codec-store-")), "system.json"));
}

/** 记录 ESL 调用的假客户端。 */
function fakeEsl({ globalGetvarBody = "global_codec_prefs=OPUS,G722,PCMU,PCMA\n" } = {}) {
  const calls = [];
  return {
    calls,
    async execute(command) {
      calls.push(command);
      if (command.startsWith("global_getvar")) return { body: globalGetvarBody };
      return { body: "+OK" };
    },
  };
}

test("normalizeCodecPrefs 只保留已知编码、去重并保持顺序", () => {
  assert.deepEqual(normalizeCodecPrefs(["g722", "OPUS", "G722", "  PCMU "]), ["G722", "OPUS", "PCMU"]);
  assert.deepEqual(normalizeCodecPrefs("G722,PCMU"), ["G722", "PCMU"]);
  assert.deepEqual(normalizeCodecPrefs(["PCMA"]), ["PCMA"]);
});

test("normalizeCodecPrefs 拒绝空集合与未知编码", () => {
  assert.throws(() => normalizeCodecPrefs([]), /至少需要保留一种编码格式/);
  assert.throws(() => normalizeCodecPrefs(""), /至少需要保留一种编码格式/);
  assert.throws(() => normalizeCodecPrefs(["G729", "AMR"]), /至少需要保留一种编码格式/);
  // 已知编码混在未知编码里时，剔除未知项而不是整体报错
  assert.deepEqual(normalizeCodecPrefs(["G729", "G722"]), ["G722"]);
});

test("CODEC_CATALOG 与 FreeSWITCH 编译/加载清单一致", () => {
  const buildManifest = readFileSync(join(root, "infra", "freeswitch", "modules.conf"), "utf8");
  const loadManifest = readFileSync(join(root, "infra", "freeswitch", "config", "modules.conf.xml"), "utf8");
  for (const codec of CODEC_CATALOG) {
    // G.711（PCMU/PCMA）由 FreeSWITCH 核心内建，不需要模块
    if (!codec.module.startsWith("mod_")) continue;
    // 按模块名匹配而非 `codecs/${module}`：mod_spandsp（提供 G.722）在源码树里
    // 位于 src/mod/applications/，写死 codecs/ 前缀会漏判。
    assert.ok(new RegExp(`^\\s*\\S*/${codec.module}\\s*$`, "m").test(buildManifest), `${codec.id} 的 ${codec.module} 未编入镜像`);
    assert.ok(loadManifest.includes(`<load module="${codec.module}"/>`), `${codec.id} 的 ${codec.module} 未加载`);
  }
});

test("SystemStore 默认包含 G722 的编码顺序", () => {
  assert.deepEqual(tempStore().getConfig().codecPrefs, DEFAULT_CODEC_PREFS);
  assert.ok(DEFAULT_CODEC_PREFS.includes("G722"));
});

test("updateConfig 未传 codecPrefs 时保留原值", () => {
  const store = tempStore();
  store.updateConfig({ codecPrefs: ["G722", "PCMU"] });
  // 前端切换主题只提交 theme，不能把编码顺序重置掉
  const updated = store.updateConfig({ theme: "dark" });
  assert.deepEqual(updated.codecPrefs, ["G722", "PCMU"]);
  assert.equal(updated.theme, "dark");
});

test("SystemStore 读取到缺失 codecPrefs 的旧数据时回落到默认值", () => {
  const store = tempStore();
  store.state.config.codecPrefs = undefined;
  store.persist();
  assert.deepEqual(new SystemStore(store.file).getConfig().codecPrefs, DEFAULT_CODEC_PREFS);
});

class FakeSystemStore {
  constructor() { this.config = { codecPrefs: [...DEFAULT_CODEC_PREFS] }; }
  updateConfig(input) { if (input.codecPrefs) this.config.codecPrefs = input.codecPrefs; return this.config; }
}

test("CodecService 读取当前生效顺序（FreeSWITCH 离线时返回 null）", async () => {
  const esl = fakeEsl({ globalGetvarBody: "global_codec_prefs=OPUS,G722\n" });
  assert.deepEqual(await new CodecService({ esl }).activePrefs(), ["OPUS", "G722"]);

  const offline = new CodecService({ esl: { async execute() { throw new Error("ESL connection closed"); } } });
  assert.equal(await offline.activePrefs(), null);
});

test("CodecService.apply 写入两个全局变量并重启 SIP profile", async () => {
  const esl = fakeEsl();
  const result = await new CodecService({ esl }).apply(["G722", "PCMU"]);
  assert.deepEqual(result.prefs, ["G722", "PCMU"]);
  assert.equal(result.restarted, true);
  assert.deepEqual(esl.calls, [
    "global_setvar global_codec_prefs=G722,PCMU",
    "global_setvar outbound_codec_prefs=G722,PCMU",
    "sofia profile internal restart",
  ]);
});

test("CodecService.apply 的 restartProfile=false 不会打断在线终端", async () => {
  const esl = fakeEsl();
  const result = await new CodecService({ esl }).apply(["PCMU"], { restartProfile: false });
  assert.equal(result.restarted, false);
  assert.equal(esl.calls.some((command) => command.startsWith("sofia profile")), false);
});

test("CodecService 应用失败会向上抛出，由调用方决定是否保留配置", async () => {
  const esl = { async execute() { throw new Error("ESL authentication failed"); } };
  await assert.rejects(() => new CodecService({ esl }).apply(["PCMU"]), /ESL authentication failed/);
});
