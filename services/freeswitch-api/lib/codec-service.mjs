/**
 * 编解码（Codec）偏好管理。
 *
 * 分两层：
 *   1. 持久化：codec 顺序存在 SystemStore 的配置里（system.json）；
 *   2. 生效：通过 ESL 把顺序写进 FreeSWITCH 的全局变量并重启 SIP profile。
 *
 * 第 2 步有个必须知道的坑：sofia profile 在**加载时**就把 codec prefs 缓存进
 * 了内存，只改全局变量对已加载的 profile 毫无影响。所以必须重启 profile 让它
 * 重新读取 —— 代价是该 profile 下所有终端注册会被清空并重新注册（通常数秒）。
 */

// 平台可用的编解码清单。必须与 infra/freeswitch/modules.conf 的编译清单、
// infra/freeswitch/config/modules.conf.xml 的加载清单保持一致：
//   - OPUS → codecs/mod_opus
//   - G722 → applications/mod_spandsp（注意：FreeSWITCH **没有**独立的
//     mod_g722，G.722 编解码器由 mod_spandsp 提供，源码树位于
//     src/mod/applications/mod_spandsp 而不是 src/mod/codecs/）
//   - PCMU / PCMA → G.711，FreeSWITCH 核心内建，不需要任何模块
//
// 这里曾经踩过坑：prefs 里一直写着 G722，但加载清单里没有提供 G722 的模块，
// 结果 G722 静默失效、看起来"配了却不生效"。tests/freeswitch-codecs.test.mjs
// 与 codec-service.test.mjs 都用来守住这条约束。
export const CODEC_CATALOG = [
  {
    id: "OPUS",
    name: "Opus",
    module: "mod_opus",
    rate: 48000,
    bitrate: "6–510 kbps（自适应）",
    bandwidth: "20 Hz–20 kHz",
    note: "抗丢包与低延迟表现最好，宽带终端首选",
  },
  {
    id: "G722",
    name: "G.722",
    module: "mod_spandsp",
    rate: 16000,
    bitrate: "64 kbps",
    bandwidth: "50 Hz–7 kHz",
    // RFC 3551 §4.5.2：G722 的 RTP 时钟率字段必须写 8000（RFC 1890 的历史
    // 遗留错误），但音频本身是 16 kHz 采样。别拿 SDP 里的 8000 去解码。
    note: "宽带语音；SDP 中写作 G722/8000，实际为 16 kHz 采样",
  },
  {
    id: "PCMU",
    name: "G.711 μ-law",
    module: "核心内建",
    rate: 8000,
    bitrate: "64 kbps",
    bandwidth: "300 Hz–3.4 kHz",
    note: "窄带，兼容性最好，几乎所有 SIP 终端都支持",
  },
  {
    id: "PCMA",
    name: "G.711 A-law",
    module: "核心内建",
    rate: 8000,
    bitrate: "64 kbps",
    bandwidth: "300 Hz–3.4 kHz",
    note: "窄带，欧洲与国内程控设备常见",
  },
];

export const DEFAULT_CODEC_PREFS = ["OPUS", "G722", "PCMU", "PCMA"];
const CODEC_IDS = new Set(CODEC_CATALOG.map((item) => item.id));

function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }

/** 校验并归一化：只保留已知 codec、去重、并保持调用方给出的优先级顺序。 */
export function normalizeCodecPrefs(input) {
  const raw = Array.isArray(input) ? input : String(input ?? "").split(",");
  const prefs = [];
  for (const item of raw) {
    const id = String(item ?? "").trim().toUpperCase();
    if (!CODEC_IDS.has(id) || prefs.includes(id)) continue;
    prefs.push(id);
  }
  if (!prefs.length) throw problem("至少需要保留一种编码格式");
  return prefs;
}

export class CodecService {
  constructor({ esl, profile = "internal" }) {
    this.esl = esl;
    // 项目只发布 internal 这一个 SIP profile（见 sip_profiles/internal.xml）。
    this.profile = profile;
  }

  /** 读取 FreeSWITCH 当前生效的全局 prefs；FreeSWITCH 离线时返回 null。 */
  async activePrefs() {
    try {
      const response = await this.esl.execute("global_getvar global_codec_prefs");
      const match = String(response.body ?? "").trim().match(/global_codec_prefs=(.*)$/);
      if (!match) return [];
      return match[1].split(",").map((item) => item.trim()).filter(Boolean);
    } catch {
      return null;
    }
  }

  /**
   * 把 prefs 写进 FreeSWITCH 并重启 SIP profile 使其生效。
   * restartProfile=false 时只写全局变量（等下次启动生效），不打断在线终端。
   */
  async apply(prefs, { restartProfile = true } = {}) {
    const value = prefs.join(",");
    await this.esl.execute(`global_setvar global_codec_prefs=${value}`);
    await this.esl.execute(`global_setvar outbound_codec_prefs=${value}`);
    let restarted = false;
    if (restartProfile) {
      await this.esl.execute(`sofia profile ${this.profile} restart`);
      restarted = true;
    }
    return { prefs: [...prefs], restarted, appliedAt: new Date().toISOString() };
  }
}
