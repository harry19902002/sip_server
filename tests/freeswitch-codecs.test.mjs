import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 防止「prefs 里写了某个 codec、但提供它的模块既没编译也没加载」这类静默失效。
// 两个真实案例：
//   1. G722 之前就踩过：vars.xml 里一直有 G722，但清单里没有提供 G722 的模块，
//      终端根本协商不出宽带语音；
//   2. 修 (1) 时又误加了 `codecs/mod_g722` —— FreeSWITCH 并没有这个模块，
//      G.722 实际由 mod_spandsp 提供，加错的模块名会让 FreeSWITCH 启动失败。

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const read = (relative) => readFileSync(join(root, relative), "utf8");

const buildManifest = read("infra/freeswitch/modules.conf");
const loadManifest = read("infra/freeswitch/config/modules.conf.xml");
const entrypoint = read("infra/freeswitch/docker-entrypoint.sh");
const launcherConfig = read("launcher/core/freeswitch_config.py");
const launcherSettings = read("launcher/core/config.py");
const compose = read("compose.yaml");

/** modules.conf 每行形如 `codecs/mod_opus` 或 `applications/mod_spandsp`，取最后一段作为模块名。 */
function builtModules() {
  return new Set(
    buildManifest
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("/").pop()),
  );
}

function loadedModules() {
  return [...loadManifest.matchAll(/<load\s+module="([^"]+)"/g)].map((match) => match[1]);
}

test("G.722 的提供模块（mod_spandsp）既编译也加载", () => {
  // 回归守卫：FreeSWITCH **没有** mod_g722 —— G.722 编解码器由 mod_spandsp
  // 提供。曾误加 codecs/mod_g722 到清单里，那是个不存在的模块，
  // 会让 FreeSWITCH 启动时加载失败。
  assert.equal(builtModules().has("mod_g722"), false, "mod_g722 并不存在，不能出现在编译清单里");
  assert.equal(loadedModules().includes("mod_g722"), false, "mod_g722 并不存在，不能出现在加载清单里");
  assert.ok(builtModules().has("mod_spandsp"), "modules.conf 缺少 applications/mod_spandsp，镜像里不会有 G.722");
  assert.ok(loadedModules().includes("mod_spandsp"), "modules.conf.xml 未加载 mod_spandsp，G.722 不生效");
});

test("运行时加载的模块都在编译清单内", () => {
  const built = builtModules();
  for (const module of loadedModules()) {
    assert.ok(built.has(module), `${module} 被加载但没有编译，启动会报模块缺失`);
  }
});

test("Docker 与便携两条链路的编解码优先级都包含 G722", () => {
  assert.match(entrypoint, /OPUS,G722,PCMU,PCMA/, "docker-entrypoint.sh 默认 prefs 缺少 G722");
  assert.match(launcherConfig, /DEFAULT_CODEC_PREFS\s*=\s*"[^"]*G722/, "freeswitch_config.py 默认 prefs 缺少 G722");
  assert.match(launcherSettings, /codec_prefs:\s*str\s*=\s*"[^"]*G722/, "AppConfig.codec_prefs 默认缺少 G722");
});

test("编解码优先级可通过环境变量覆盖", () => {
  assert.match(entrypoint, /FREESWITCH_CODEC_PREFS/, "entrypoint 未读取 FREESWITCH_CODEC_PREFS");
  assert.match(compose, /FREESWITCH_CODEC_PREFS/, "compose.yaml 未透传 FREESWITCH_CODEC_PREFS");
  assert.match(launcherSettings, /"FREESWITCH_CODEC_PREFS":\s*"codec_prefs"/, "启动器未映射该环境变量");
});
