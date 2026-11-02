"use client";

/* Prototype modals intentionally use click-away backdrops and wrapped visual
 * labels. Keyboard-accessible close buttons remain available in every dialog. */
/* eslint-disable jsx-a11y/media-has-caption, jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-static-element-interactions, jsx-a11y/no-autofocus */

import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import PresetBroadcasts from "./preset-broadcasts";

type PageKey =
  | "overview"
  | "shortcuts"
  | "realtime"
  | "presets"
  | "schedule"
  | "tasks"
  | "content"
  | "terminals"
  | "resources"
  | "sipAccounts"
  | "permissions"
  | "system";

type Role = "系统管理员" | "广播操作员";
type Theme = "light" | "dark";

type BackendBroadcastTarget = {
  id: string;
  extension: string;
  state: string;
  failureCause: string | null;
  answeredAt?: string | null;
  finishedAt?: string | null;
};

type BackendBroadcast = {
  id: string;
  name: string;
  type: "REALTIME" | "PRESET";
  state: string;
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string | null;
  audio?: string;
  volume?: number;
  playMode?: "ONCE" | "LOOP" | "SHUFFLE";
  sourceType?: "FILE" | "PLAYLIST" | "MIXED";
  sourceId?: string | null;
  sourceName?: string | null;
  sourceItems?: Array<{ type: "FILE" | "PLAYLIST"; id: string; name: string; fileCount: number }>;
  // 重发来源任务 ID：由哪个已结束的任务重新发起（首次发起为 null）。
  replayOfId?: string | null;
  targets: BackendBroadcastTarget[];
};

type MediaFile = {
  id: string;
  name: string;
  originalName: string;
  format: "WAV" | "MP3";
  contentType: string;
  size: number;
  freeswitchPath: string;
  previewToken: string;
  createdAt: string;
};

type MediaPlaylist = {
  id: string;
  name: string;
  fileIds: string[];
  files: MediaFile[];
  createdAt: string;
  updatedAt: string;
};

type LiveTerminal = {
  id: string;
  name: string;
  extension: string;
  zone: string;
  location: string;
  ip: string;
  port: string;
  transport: string;
  contact: string;
  type: string;
  status: "在线空闲" | "播放中" | "异常" | "离线";
  last: string;
  capability: string;
  priority: number;
};

// 业务 API 端口解析优先级：
//   1. 运行时注入（window.__SIP_RUNTIME__.apiPort）——启动器在 HTML 里写入，
//      这样在 GUI 里改端口无需重新构建前端；
//   2. 构建期注入（VITE_API_PORT）——便携版打包时可烘焙默认值；
//   3. 兜底 3001。
const runtimeConfig: { apiPort?: string; version?: string } | undefined =
  (globalThis as { __SIP_RUNTIME__?: { apiPort?: string; version?: string } }).__SIP_RUNTIME__;
const broadcastApiPort =
  runtimeConfig?.apiPort || (import.meta.env?.VITE_API_PORT as string | undefined) || "3001";
const broadcastApiBase = `http://${typeof window === "undefined" ? "127.0.0.1" : window.location.hostname}:${broadcastApiPort}/api/v1`;

// 版本号（形如 0.1.0+20260912.1004）由启动器运行时注入；直接以浏览器打开时为「开发模式」。
const appVersion = runtimeConfig?.version || (import.meta.env?.VITE_APP_VERSION as string | undefined) || "";
function formatAppVersion(version: string): string {
  if (!version) return "开发模式";
  const [base, stamp] = version.split("+");
  if (!stamp || stamp === "dev") return `${base} · 开发模式`;
  const match = /^(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})$/.exec(stamp);
  if (!match) return version;
  return `${base} · ${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

const failureCauseMeta: Record<string, { label: string; description: string }> = {
  RECOVERY_ON_TIMER_EXPIRE: { label: "终端响应超时", description: "呼叫未在规定时间内建立" },
  NORMAL_TEMPORARY_FAILURE: { label: "临时通信故障", description: "线路或终端暂时不可用" },
  NO_ANSWER: { label: "终端未应答", description: "终端在等待时间内未接听" },
  USER_BUSY: { label: "终端忙", description: "终端正在通话或占用中" },
  CALL_REJECTED: { label: "呼叫被拒绝", description: "终端拒绝了本次广播呼叫" },
  UNALLOCATED_NUMBER: { label: "号码不存在", description: "SIP 账号或号码未配置" },
  DESTINATION_OUT_OF_ORDER: { label: "终端不可达", description: "无法连接到目标终端" },
  NETWORK_OUT_OF_ORDER: { label: "通信网络异常", description: "网络暂时无法完成呼叫" },
  ORIGINATOR_CANCEL: { label: "呼叫已取消", description: "广播建立前被主动停止" },
  dispatch_failed: { label: "任务下发失败", description: "广播请求未能发送到终端" },
  UNKNOWN: { label: "其他通信故障", description: "暂未识别具体失败原因" },
};

function getFailureCauseMeta(cause: string) {
  return failureCauseMeta[cause] ?? { label: "其他通信故障", description: "请查看任务详情或检查终端状态" };
}

// 广播任务的状态分组。这些集合是恒定常量，放在模块作用域有两个好处：
//   1. 不会因每次渲染新建 Set 而让依赖它们的 useCallback/useEffect 反复重建；
//   2. 组件内任何位置（含 useCallback 回调）都可安全引用，不存在 TDZ 风险。
const activeTaskStates = new Set(["DISPATCHING", "RUNNING", "CANCELED_REQUESTED"]);
const failedTaskStates = new Set(["FAILED", "PARTIAL_FAILED"]);
const completedTaskStates = new Set(["SUCCEEDED", "FAILED", "PARTIAL_FAILED", "CANCELED"]);

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${broadcastApiBase}${path}`, { ...init, credentials: "include" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? `请求失败（${response.status}）`);
  return payload as T;
}

function LoginScreen({ onLogin }: { onLogin: (user: SystemUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const login = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError("");
    try { const payload = await apiRequest<{ user: SystemUser }>("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) }); onLogin(payload.user); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "登录失败"); }
    finally { setSubmitting(false); }
  };
  return <main className="login-page"><section className="login-panel"><div className="login-brand"><span className="brand-mark"><i /><i /><i /></span><div><b>SIP广播系统</b><small>SIP BROADCAST SYSTEM</small></div></div><div className="login-heading"><span>账号登录</span><h1>登录系统</h1><p>请输入用户名和密码访问广播管理平台。</p></div>{error && <div className="login-error">{error}</div>}<form onSubmit={(event) => void login(event)}><label><span>用户名</span><input autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="请输入用户名" /></label><label><span>密码</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" /></label><button className="button button-primary" disabled={submitting || !username.trim() || !password}>{submitting ? "正在登录…" : "登录"}</button></form><div className="login-footer"><i />通信服务已连接</div></section><aside className="login-visual"><div><span>安全访问</span><h2>统一管理广播任务、终端、媒体与系统资源</h2><p>登录后将按照用户角色加载对应的管理权限。</p></div></aside></main>;
}

const navGroups: Array<{ label: string; items: Array<{ key: PageKey; label: string; icon: string; badge?: string }> }> = [
  { label: "工作台", items: [
    // 快捷入口是默认首页（登录后直接进入），因此排在第一位。
    { key: "shortcuts", label: "快捷入口", icon: "⚡" },
    { key: "overview", label: "运行总览", icon: "⌂" },
  ] },
  {
    label: "广播业务",
    items: [
      { key: "realtime", label: "实时广播", icon: "◉" },
      { key: "presets", label: "预设广播", icon: "▣" },
      { key: "schedule", label: "定时计划", icon: "◷" },
      { key: "tasks", label: "任务中心", icon: "≡" },
      { key: "content", label: "媒体库", icon: "♪" },
    ],
  },
  {
    label: "运营管理",
    items: [
      { key: "terminals", label: "终端列表", icon: "▤" },
      { key: "resources", label: "分区管理", icon: "⌘" },
    ],
  },
  {
    label: "系统",
    items: [
      { key: "sipAccounts", label: "SIP 账号管理", icon: "#" },
      { key: "permissions", label: "用户与权限", icon: "♙" },
      { key: "system", label: "系统配置", icon: "settings" },
    ],
  },
];

type SipAccount = {
  id: number;
  account: string;
  name: string;
  displayNumber: string;
  department: string;
  enabled: boolean;
  registration: "在线" | "未注册";
  lastRegistered: string;
  transport: string;
  domain?: string;
  context?: string;
  contact?: string;
  password?: string;
};

type BackendSchedule = {
  id: string;
  name: string;
  mediaFileId: string;
  /** 播放内容多选：文件 / 播放列表，按顺序组成播放队列 */
  sourceItems: Array<{ type: "FILE" | "PLAYLIST"; id: string }>;
  zoneIds: string[];
  repeat: "ONCE" | "DAILY" | "WEEKDAYS" | "WEEKLY";
  date: string;
  time: string;
  volume: number;
  /** 播放模式：单次 / 循环 / 随机 */
  playMode: "ONCE" | "LOOP" | "SHUFFLE";
  /** 播放时长（分钟）；0 = 一直播放直到手动停止。仅循环/随机生效 */
  durationMinutes: number;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastBroadcastId: string | null;
  lastError: string | null;
  createdAt: string;
  media: MediaFile | null;
  sources: Array<{ type: "FILE" | "PLAYLIST"; id: string; name: string; fileCount: number; missing: boolean }>;
  zones: Array<{ id: string; name: string; terminalIds: string[] }>;
  lastBroadcast: BackendBroadcast | null;
};

type SystemUser = { id: string; username: string; name: string; role: Role; enabled: boolean; createdAt: string; updatedAt: string };
type PermissionRule = { capability: string; admin: string; operator: string };
type SystemConfigData = { organizationName: string; organizationCode: string; contact: string; phone: string; theme: Theme; codecPrefs?: string[]; updatedAt: string };

// 编解码元数据。id 必须与后端 codec-service.mjs 的 CODEC_CATALOG 一致：
// 该清单直接对应 FreeSWITCH 编译/加载的模块（OPUS→mod_opus、G722→mod_spandsp、
// PCMU/PCMA 为 G.711 核心内建）。注意 FreeSWITCH 没有独立的 mod_g722。
// 此处只做展示，真实清单由接口下发。
type CodecInfo = { id: string; name: string; module: string; rate: number; bitrate: string; bandwidth: string; note: string };

function Icon({ children }: { children: string }) {
  if (children === "settings") {
    return <span className="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg></span>;
  }
  return <span className="nav-icon" aria-hidden="true">{children}</span>;
}

function Status({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "success" | "warning" | "danger" | "info" | "neutral" }) {
  return <span className={`status status-${tone}`}><i />{children}</span>;
}

// ---------- 快捷入口 ----------
//
// 「快捷入口」是左侧导航里的独立页面：集中展示用户自定义的常用页面快捷方式，
// 并可在这里增删、排序。配置保存在浏览器本地（localStorage）：
// 它属于个人使用偏好，换设备/换账号各自独立更符合直觉，
// 也避免了后端多一份存储与接口。
const SHORTCUT_STORAGE_KEY = "sip-shortcuts";
// 最多显示的快捷入口数量；再多页面就退化成第二份导航了。
const MAX_SHORTCUTS = 8;

type ShortcutItem = { key: PageKey; label: string; icon: string };

// 可选页面清单取自左侧导航，但排除「快捷入口」自身
// （否则会出现「快捷入口的快捷入口」这种无意义项），
// 这样导航改名后这里自动跟随，不必两处维护。
const shortcutCatalog: ShortcutItem[] = navGroups
  .flatMap((group) => group.items)
  .filter((item) => item.key !== "shortcuts");
const DEFAULT_SHORTCUTS: PageKey[] = ["realtime", "presets", "schedule", "tasks", "content"];

function shortcutOf(key: PageKey): ShortcutItem {
  return shortcutCatalog.find((item) => item.key === key) ?? { key, label: key, icon: "›" };
}

/**
 * 读取浏览器里保存的快捷入口原始串。
 * 服务端渲染时返回空串，由调用方回退到默认值。
 */
function readShortcutSnapshot(): string {
  try { return window.localStorage.getItem(SHORTCUT_STORAGE_KEY) ?? ""; } catch { return ""; }
}

// 同一标签页内写入 localStorage 不会触发 storage 事件，
// 因此额外用一个订阅列表通知本页的 useSyncExternalStore 重新取值。
const shortcutListeners = new Set<() => void>();

function subscribeShortcuts(listener: () => void): () => void {
  shortcutListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    shortcutListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function writeShortcuts(next: PageKey[]): void {
  try { window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(next)); } catch { /* 隐私模式写入会失败，仅本次有效 */ }
  for (const listener of shortcutListeners) listener();
}

/**
 * 把存储内容解析成快捷入口列表。
 * 配置损坏、或其中包含已不存在的页面时都退回默认值，
 * 避免历史脏数据让首页渲染出点了没反应的死按钮。
 */
function parseShortcuts(raw: string): PageKey[] {
  if (!raw) return DEFAULT_SHORTCUTS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SHORTCUTS;
    const known = new Set(shortcutCatalog.map((item) => item.key));
    const valid = parsed.filter((key): key is PageKey => typeof key === "string" && known.has(key as PageKey));
    // 去重后截断，避免手改过的配置把首页撑爆
    return [...new Set(valid)].slice(0, MAX_SHORTCUTS);
  } catch {
    return DEFAULT_SHORTCUTS;
  }
}

/**
 * 交换数组中的两项，用于快捷入口排序。
 * 越界时原样返回，避免首/末项上移下移把元素弄丢。
 */
function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

function Overview({ go }: { go: (page: PageKey) => void }) {
  const [terminals, setTerminals] = useState<LiveTerminal[]>([]);
  const [managedZones, setManagedZones] = useState<Array<{ id: string; name: string; terminalIds: string[] }>>([]);
  const [broadcasts, setBroadcasts] = useState<BackendBroadcast[]>([]);
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [playlistCount, setPlaylistCount] = useState(0);
  const [accountCount, setAccountCount] = useState(0);
  const [freeSwitchOnline, setFreeSwitchOnline] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [statusPayload, terminalPayload, zonePayload, broadcastPayload, mediaPayload, playlistPayload, accountPayload] = await Promise.all([
        apiRequest<{ status: string }>("/freeswitch/status"),
        apiRequest<{ items: LiveTerminal[] }>("/registrations"),
        apiRequest<{ items: Array<{ id: string; name: string; terminalIds: string[] }> }>("/zones"),
        apiRequest<{ items: BackendBroadcast[] }>("/broadcasts"),
        apiRequest<{ items: MediaFile[] }>("/media/files"),
        apiRequest<{ count: number }>("/media/playlists"),
        apiRequest<{ items: SipAccount[] }>("/sip-accounts"),
      ]);
      setFreeSwitchOnline(/^UP\b/m.test(statusPayload.status));
      setTerminals(terminalPayload.items);
      setManagedZones(zonePayload.items);
      setBroadcasts(broadcastPayload.items);
      setMediaFiles(mediaPayload.items);
      setPlaylistCount(playlistPayload.count);
      setAccountCount(accountPayload.items.length);
      setUpdatedAt(new Date().toISOString());
      setLoadError("");
    } catch (error) {
      setFreeSwitchOnline(false);
      setLoadError(error instanceof Error ? error.message : "无法读取系统状态");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  const terminalStates = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
  const activeBroadcasts = broadcasts.filter((broadcast) => !["SUCCEEDED", "PARTIAL_FAILED", "FAILED", "CANCELED"].includes(broadcast.state));
  const latestBroadcast = activeBroadcasts[0] ?? broadcasts[0];
  const completedTargets = latestBroadcast?.targets.filter((target) => terminalStates.has(target.state)).length ?? 0;
  const succeededTargets = latestBroadcast?.targets.filter((target) => target.state === "SUCCEEDED").length ?? 0;
  const failedTargets = latestBroadcast?.targets.filter((target) => target.state === "FAILED").length ?? 0;
  const answeredTargets = latestBroadcast?.targets.filter((target) => Boolean(target.answeredAt) && !terminalStates.has(target.state)).length ?? 0;
  const latestMedia = mediaFiles.find((file) => file.freeswitchPath === latestBroadcast?.audio);
  const recentBroadcasts = broadcasts.slice(0, 5);
  const dateLabel = new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date());
  const stateLabel = (broadcast: BackendBroadcast) => {
    if (broadcast.state === "RUNNING" && !broadcast.targets.some((target) => Boolean(target.answeredAt))) return "呼叫中";
    return ({ DISPATCHING: "下发中", RUNNING: "播放中", SUCCEEDED: "成功", PARTIAL_FAILED: "部分成功", FAILED: "失败", CANCELED_REQUESTED: "停止中", CANCELED: "已停止" } as Record<string, string>)[broadcast.state] ?? broadcast.state;
  };
  const stateTone = (broadcast: BackendBroadcast): "success" | "warning" | "danger" | "info" | "neutral" => {
    if (broadcast.state === "SUCCEEDED") return "success";
    if (["FAILED", "PARTIAL_FAILED"].includes(broadcast.state)) return "danger";
    if (["RUNNING", "DISPATCHING"].includes(broadcast.state)) return "info";
    return "neutral";
  };

  return (
    <div className="page overview-page">
      <div className="page-heading split-heading">
        <div>
          <div className="eyebrow">{dateLabel}</div>
          <h1>运行总览</h1>
          <p>{freeSwitchOnline ? `通信服务运行正常，当前 ${terminals.length} 台 SIP 终端在线。` : "通信服务异常或暂时无法连接，请检查服务状态。"}{updatedAt ? ` 最近同步：${new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}</p>
        </div>
        <div className="heading-actions">
          <button className="button button-secondary" onClick={() => void refresh()}>↻ 刷新状态</button>
          <button className="button button-primary" onClick={() => go("realtime")}>◉ 发起实时广播</button>
        </div>
      </div>

      {loadError && <div className="media-error"><span>!</span>首页数据加载失败：{loadError}</div>}

      <section className="metric-grid" aria-label="核心指标">
        <article className="metric-card accent-blue">
          <div className="metric-top"><span className="metric-icon">⌘</span><span className={freeSwitchOnline ? "trend up" : "trend"}>{freeSwitchOnline ? "服务正常" : "连接异常"}</span></div>
          <strong>{terminals.length} <small>/ {accountCount}</small></strong>
          <h3>在线 SIP 终端</h3>
          <p>{accountCount} 个 SIP 账号 · {managedZones.length} 个分区</p>
        </article>
        <article className="metric-card accent-green">
          <div className="metric-top"><span className="metric-icon">◉</span>{activeBroadcasts.length > 0 && <span className="live-dot">LIVE</span>}</div>
          <strong>{activeBroadcasts.length}</strong>
          <h3>活动广播任务</h3>
          <p>涉及 {activeBroadcasts.reduce((sum, broadcast) => sum + broadcast.targets.length, 0)} 台终端 · 共 {broadcasts.length} 条记录</p>
        </article>
        <article className="metric-card accent-violet">
          <div className="metric-top"><span className="metric-icon">♪</span><span className="trend">媒体库</span></div>
          <strong>{mediaFiles.length}</strong>
          <h3>音频文件</h3>
          <p>{playlistCount} 个播放列表 · WAV/MP3</p>
        </article>
      </section>

      <div className="dashboard-grid">
        <section className="panel active-panel">
          <div className="panel-title-row">
            <div><span className="section-kicker">{activeBroadcasts.length ? "当前广播" : "最近广播"}</span><h2>{latestBroadcast?.name ?? "暂无广播任务"}</h2></div>
            {latestBroadcast && <Status tone={stateTone(latestBroadcast)}>{stateLabel(latestBroadcast)}</Status>}
          </div>
          {latestBroadcast ? <>
            <div className="audio-visual" aria-label="广播任务状态">
              {[18, 34, 25, 47, 62, 38, 70, 52, 31, 58, 76, 45, 66, 42, 23, 54, 70, 49, 31, 18].map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}
            </div>
            <div className="play-progress"><span style={{ width: `${completedTargets / Math.max(1, latestBroadcast.targets.length) * 100}%` }} /></div>
            <div className="play-time"><span>{completedTargets} 个已结束</span><span>{latestBroadcast.targets.length} 个目标</span></div>
            <div className="active-meta">
              <div><span>播放内容</span><b>{latestBroadcast.sourceName ?? latestMedia?.name ?? latestBroadcast.audio?.split("/").pop() ?? "未记录"}</b></div>
              <div><span>终端结果</span><b>{succeededTargets} 成功 · {failedTargets} 失败 · {answeredTargets} 播放中</b></div>
              <div><span>发起时间</span><b>{new Date(latestBroadcast.createdAt).toLocaleString("zh-CN", { hour12: false })}</b></div>
            </div>
          </> : <div className="terminal-empty"><span>◉</span><h3>暂无广播记录</h3><p>从“实时广播”选择终端和播放内容后发起第一条任务。</p></div>}
          <div className="panel-footer">
            <button className="text-button" onClick={() => go("tasks")}>查看任务详情 →</button>
            <button className="button button-secondary" onClick={() => go("realtime")}>发起新广播</button>
          </div>
        </section>

        <section className="panel plans-panel">
          <div className="panel-title-row"><div><span className="section-kicker">任务记录</span><h2>最近广播</h2></div><button className="text-button" onClick={() => go("tasks")}>查看全部</button></div>
          <div className="timeline">
            {recentBroadcasts.map((broadcast) => {
              const succeeded = broadcast.targets.filter((target) => target.state === "SUCCEEDED").length;
              return <div className={`timeline-item ${broadcast.state === "SUCCEEDED" ? "done" : activeBroadcasts.some((item) => item.id === broadcast.id) ? "active" : ""}`} key={broadcast.id}><time>{new Date(broadcast.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time><i /><div><b>{broadcast.name}</b><span>{succeeded}/{broadcast.targets.length} 成功 · {stateLabel(broadcast)}</span></div></div>;
            })}
            {recentBroadcasts.length === 0 && <div className="terminal-empty"><b>暂无任务记录</b><p>广播任务会显示在这里。</p></div>}
          </div>
        </section>
      </div>

      <div className="lower-grid lower-grid-single">
        <section className="panel zone-panel">
          <div className="panel-title-row"><div><span className="section-kicker">资源概览</span><h2>分区运行情况</h2></div><button className="text-button" onClick={() => go("resources")}>管理分区与终端</button></div>
          <div className="zone-list">
            {managedZones.map((zone) => {
              const online = terminals.filter((terminal) => zone.terminalIds.includes(terminal.id)).length;
              const total = zone.terminalIds.length;
              return <div className="zone-row" key={zone.id}>
                <div className="zone-symbol">{zone.name.slice(0, 1)}</div>
                <div className="zone-main"><b>{zone.name}</b><span>{online} / {total} 台当前在线</span></div>
                <div className="mini-progress"><i style={{ width: `${online / Math.max(1, total) * 100}%` }} /></div>
                <Status tone={total > 0 && online === total ? "success" : total > 0 ? "warning" : "neutral"}>{total === 0 ? "未配置" : online === total ? "全部在线" : "部分离线"}</Status>
              </div>;
            })}
            {managedZones.length === 0 && <div className="terminal-empty"><span>⌘</span><h3>暂无分区</h3><p>请在分区管理中创建分区并分配终端。</p></div>}
          </div>
        </section>
      </div>
    </div>
  );
}

function Realtime({ onStarted, organizationName }: { onStarted: (broadcast: BackendBroadcast) => void; organizationName: string }) {
  const playModeOptions = [
    { key: "ONCE", label: "单次播放", icon: "▶", hint: "按队列顺序播放一遍后结束" },
    { key: "LOOP", label: "循环播放", icon: "∞", hint: "循环播放直到手动停止" },
    { key: "SHUFFLE", label: "随机播放", icon: "⇄", hint: "打乱队列顺序播放一遍" },
  ] as const;
  const [targetMode, setTargetMode] = useState<"zones" | "terminals">("zones");
  const [sourceMode, setSourceMode] = useState<"playlists" | "files">("playlists");
  const [zones, setZones] = useState<Array<{ id: string; name: string; terminalIds: string[] }>>([]);
  const [terminals, setTerminals] = useState<LiveTerminal[]>([]);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [playlists, setPlaylists] = useState<MediaPlaylist[]>([]);
  const [selectedZones, setSelectedZones] = useState<string[]>([]);
  const [selectedTerminals, setSelectedTerminals] = useState<string[]>([]);
  const [selectedSources, setSelectedSources] = useState<Array<{ type: "FILE" | "PLAYLIST"; id: string }>>([]);
  const [playingFile, setPlayingFile] = useState<MediaFile | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);
  // 默认 50%：该值映射到 FreeSWITCH 的 level 0，即不做任何增益（保持原始响度）。
  const [volume, setVolume] = useState(50);
  const [playMode, setPlayMode] = useState<"ONCE" | "LOOP" | "SHUFFLE">("ONCE");
  const [confirm, setConfirm] = useState(false);
  const [search, setSearch] = useState("");
  const [audioSearch, setAudioSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  // 必须在 playMode 声明之后计算：此前置于 state 之前，因回调内引用触发 TDZ
  // （ReferenceError: Cannot access 'playMode' before initialization），导致整页崩溃。
  const playModeLabel = playModeOptions.find((option) => option.key === playMode)?.label ?? "单次播放";

  const refresh = useCallback(async () => {
    try {
      const [zonePayload, terminalPayload, filePayload, playlistPayload] = await Promise.all([
        apiRequest<{ items: Array<{ id: string; name: string; terminalIds: string[] }> }>("/zones"),
        apiRequest<{ items: LiveTerminal[] }>("/registrations"),
        apiRequest<{ items: MediaFile[] }>("/media/files"),
        apiRequest<{ items: MediaPlaylist[] }>("/media/playlists"),
      ]);
      setZones(zonePayload.items);
      setTerminals(terminalPayload.items);
      setFiles(filePayload.items);
      setPlaylists(playlistPayload.items);
      setSelectedSources((current) => current.filter((source) => source.type === "FILE" ? filePayload.items.some((file) => file.id === source.id) : playlistPayload.items.some((playlist) => playlist.id === source.id && playlist.files.length > 0)));
      setSubmitError("");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "广播资源加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  const toggleZone = (id: string) => setSelectedZones((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleTerminal = (id: string) => setSelectedTerminals((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleSource = (type: "FILE" | "PLAYLIST", id: string) => setSelectedSources((current) => current.some((source) => source.type === type && source.id === id) ? current.filter((source) => !(source.type === type && source.id === id)) : [...current, { type, id }]);
  const playPreview = (file: MediaFile) => {
    const player = previewAudioRef.current;
    if (!player) return;
    player.src = `${broadcastApiBase}/media/files/${file.id}/content?preview=${encodeURIComponent(file.previewToken)}`;
    player.currentTime = 0;
    setPlayingFile(file);
    void player.play().catch(() => setSubmitError("音频试听失败，请检查文件是否可用"));
  };
  const stopPreview = () => {
    const player = previewAudioRef.current;
    if (player) { player.pause(); player.currentTime = 0; }
    setPlayingFile(null);
  };
  const sourceSelected = (type: "FILE" | "PLAYLIST", id: string) => selectedSources.some((source) => source.type === type && source.id === id);
  const sourceOrder = (type: "FILE" | "PLAYLIST", id: string) => selectedSources.findIndex((source) => source.type === type && source.id === id) + 1;
  const selectedSourceRows = selectedSources.map((source) => source.type === "FILE" ? files.find((file) => file.id === source.id) ? { ...source, name: files.find((file) => file.id === source.id)!.originalName, fileCount: 1 } : null : playlists.find((playlist) => playlist.id === source.id) ? { ...source, name: playlists.find((playlist) => playlist.id === source.id)!.name, fileCount: playlists.find((playlist) => playlist.id === source.id)!.files.length } : null).filter((source): source is { type: "FILE" | "PLAYLIST"; id: string; name: string; fileCount: number } => Boolean(source));
  const selectedSourceName = selectedSourceRows.map((source) => source.name).join("、");
  const selectedAudioCount = selectedSourceRows.reduce((count, source) => count + source.fileCount, 0);
  const sourceReady = selectedSourceRows.length > 0 && selectedAudioCount <= 100;
  const visibleZones = zones.filter((zone) => zone.name.toLowerCase().includes(search.trim().toLowerCase()));
  const visibleTerminals = terminals.filter((terminal) => [terminal.name, terminal.id, terminal.extension, terminal.zone].some((value) => value.toLowerCase().includes(search.trim().toLowerCase())));
  const visibleFiles = files.filter((file) => [file.name, file.originalName, file.format].some((value) => value.toLowerCase().includes(audioSearch.trim().toLowerCase())));
  const visiblePlaylists = playlists.filter((playlist) => playlist.name.toLowerCase().includes(audioSearch.trim().toLowerCase()));
  const selectedZoneRows = zones.filter((zone) => selectedZones.includes(zone.id));
  const selectedTerminalRows = terminals.filter((terminal) => selectedTerminals.includes(terminal.id));
  const dispatchRows = targetMode === "zones" ? terminals.filter((terminal) => selectedZoneRows.some((zone) => zone.terminalIds.includes(terminal.id))) : selectedTerminalRows;
  const dispatchTargets = Array.from(new Set(dispatchRows.map((terminal) => terminal.extension)));
  const selectedTargetCount = targetMode === "zones" ? selectedZones.length : selectedTerminals.length;
  const targetLabel = targetMode === "zones" ? selectedZoneRows.map((zone) => zone.name).join("、") : selectedTerminalRows.map((terminal) => terminal.name).join("、");
  const selectAllTargets = () => targetMode === "zones" ? setSelectedZones(visibleZones.map((zone) => zone.id)) : setSelectedTerminals(visibleTerminals.map((terminal) => terminal.id));

  const startBroadcast = async () => {
    if (!sourceReady || dispatchTargets.length === 0) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const payload = await apiRequest<{ broadcast: BackendBroadcast }>("/broadcasts", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          name: `实时广播 · ${selectedSourceRows.length === 1 ? selectedSourceName : `${selectedSourceRows.length} 项播放内容`}`,
          targets: dispatchTargets,
          sources: selectedSources,
          callerId: "9999",
          volume,
          playMode,
        }),
      });
      setConfirm(false);
      onStarted(payload.broadcast);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "广播任务创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page realtime-page">
      <div className="page-heading"><div className="breadcrumb">广播中心 / 实时广播</div><h1>发起实时广播</h1></div>
      {submitError && <div className="media-error"><span>!</span>{submitError}<button onClick={() => setSubmitError("")}>×</button></div>}

      <div className="steps" aria-label="广播配置步骤">
        <div className="step active"><span>1</span><div><b>广播目标</b><small>{targetMode === "zones" ? `${selectedZones.length} 个分区` : `${selectedTerminals.length} 台终端`}</small></div></div><i />
        <div className={`step ${sourceReady ? "active" : ""}`}><span>2</span><div><b>播放内容</b><small>{selectedSourceRows.length ? `${selectedSourceRows.length} 项 · ${selectedAudioCount} 个音频` : "未选择"}</small></div></div><i />
        <div className={`step ${dispatchTargets.length && sourceReady ? "active" : ""}`}><span>3</span><div><b>执行策略</b><small>{playModeLabel} · 音量 {volume}%</small></div></div>
      </div>

      <div className="broadcast-builder">
        <section className="builder-card target-picker">
          <div className="builder-title"><div><span>01</span><h2>选择广播目标</h2></div><button className="text-button" onClick={selectAllTargets}>全选当前</button></div>
          <div className="target-mode-tabs"><button className={targetMode === "zones" ? "active" : ""} onClick={() => { setTargetMode("zones"); setSearch(""); }}>⌘ 按分区</button><button className={targetMode === "terminals" ? "active" : ""} onClick={() => { setTargetMode("terminals"); setSearch(""); }}>▤ 按在线终端</button></div>
          <label className="search-field"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={targetMode === "zones" ? "搜索分区" : "搜索终端名称、SIP ID 或分机号"} /></label>
          <div className="tree-root"><span className="tree-toggle">⌄</span><b>{organizationName}</b><small>{terminals.length} 台在线</small></div>
          {targetMode === "zones" && <div className="zone-check-list">{visibleZones.map((zone) => {
            const online = terminals.filter((terminal) => zone.terminalIds.includes(terminal.id)).length;
            return <label className="zone-check" key={zone.id}><input type="checkbox" checked={selectedZones.includes(zone.id)} onChange={() => toggleZone(zone.id)} /><span className="custom-check">✓</span><span className="folder">▰</span><span><b>{zone.name}</b><small>{online} / {zone.terminalIds.length} 台当前在线</small></span></label>;
          })}{!loading && visibleZones.length === 0 && <div className="target-list-empty">暂无分区，请先到分区管理中新建并配置终端。</div>}</div>}
          {targetMode === "terminals" && <div className="zone-check-list terminal-target-list">{visibleTerminals.map((terminal) => <label className="zone-check terminal-target-check" key={terminal.id}><input type="checkbox" checked={selectedTerminals.includes(terminal.id)} onChange={() => toggleTerminal(terminal.id)} /><span className="custom-check">✓</span><span className="target-terminal-icon">◖</span><span><b>{terminal.name}</b><small>{terminal.extension} · {terminal.zone} · {terminal.ip}</small></span><em className="target-status online">{terminal.status}</em></label>)}{!loading && visibleTerminals.length === 0 && <div className="target-list-empty">暂无在线终端。</div>}</div>}
          <div className="selection-summary"><div><strong>{selectedTargetCount}</strong><span>{targetMode === "zones" ? "已选分区" : "已选终端"}</span></div><div><strong>{dispatchTargets.length}</strong><span>覆盖终端</span></div><div><strong className="success-number">{terminals.length}</strong><span>当前在线</span></div></div>
        </section>

        <section className="builder-card source-picker">
          <div className="builder-title"><div><span>02</span><h2>选择播放内容</h2></div><button className="text-button" disabled={!selectedSources.length} onClick={() => setSelectedSources([])}>清空已选</button></div>
          <div className="target-mode-tabs"><button className={sourceMode === "playlists" ? "active" : ""} onClick={() => { setSourceMode("playlists"); setAudioSearch(""); stopPreview(); }}>≡ 播放列表</button><button className={sourceMode === "files" ? "active" : ""} onClick={() => { setSourceMode("files"); setAudioSearch(""); }}>♪ 音频文件</button></div>
          <label className="search-field"><span>⌕</span><input value={audioSearch} onChange={(event) => setAudioSearch(event.target.value)} placeholder={sourceMode === "playlists" ? "搜索播放列表" : "搜索 WAV 或 MP3"} /></label>
          {sourceMode === "playlists" && <div className="audio-list">{visiblePlaylists.map((playlist) => { const selected = sourceSelected("PLAYLIST", playlist.id); return <button className={`audio-row ${selected ? "selected" : ""}`} disabled={playlist.files.length === 0} key={playlist.id} onClick={() => toggleSource("PLAYLIST", playlist.id)}><span className="source-check">{selected ? "✓" : ""}</span><span className="play-circle">≡</span><span><b>{playlist.name}</b><small>{playlist.files.length ? `${playlist.files.length} 个音频 · ${playlist.files.map((file) => file.format).join(" / ")}` : "空播放列表，不可广播"}</small></span>{selected && <em>第 {sourceOrder("PLAYLIST", playlist.id)} 项</em>}</button>; })}{!loading && visiblePlaylists.length === 0 && <div className="target-list-empty">媒体库没有播放列表，请先创建并添加音频。</div>}</div>}
          {sourceMode === "files" && <div className="audio-list">{visibleFiles.map((file) => { const selected = sourceSelected("FILE", file.id); const playing = playingFile?.id === file.id; return <div className={`audio-row audio-file-row ${selected ? "selected" : ""} ${playing ? "is-playing" : ""}`} key={file.id}><button className="audio-select-area" onClick={() => toggleSource("FILE", file.id)}><span className="source-check">{selected ? "✓" : ""}</span><span className="play-circle">♪</span><span><b>{file.originalName}</b><small>{file.format} · {(file.size / 1024).toFixed(0)} KB</small></span>{selected && <em>第 {sourceOrder("FILE", file.id)} 项</em>}</button><div className="inline-preview-actions"><button className={playing ? "active" : ""} onClick={() => playPreview(file)} aria-label={`播放 ${file.originalName}`}><span>▶</span>播放</button><button disabled={!playing} onClick={stopPreview} aria-label={`停止 ${file.originalName}`}><span>■</span>停止</button></div></div>; })}{!loading && visibleFiles.length === 0 && <div className="target-list-empty">媒体库没有可用 WAV/MP3，请先上传音频。</div>}<audio ref={previewAudioRef} className="inline-preview-audio" onEnded={() => setPlayingFile(null)} /></div>}
          {selectedSourceRows.length > 0 && <div className={`strategy-note source-queue-note ${selectedAudioCount > 100 ? "has-error" : ""}`}><span>≡</span><p><b>播放队列：{selectedSourceRows.length} 项，共 {selectedAudioCount} 个音频</b><small>{selectedSourceRows.map((source, index) => `${index + 1}. ${source.name}`).join(" → ")}</small>{selectedAudioCount > 100 && <em>展开后的音频不能超过 100 个，请减少选择。</em>}</p></div>}
          <div className="play-mode-block">
            <div className="play-mode-head"><span>播放模式</span><small>{playModeOptions.find((option) => option.key === playMode)?.hint}</small></div>
            <div className="play-mode-tabs" role="radiogroup" aria-label="播放模式">
              {playModeOptions.map((option) => <button type="button" role="radio" aria-checked={playMode === option.key} className={playMode === option.key ? "active" : ""} key={option.key} onClick={() => setPlayMode(option.key)}><span>{option.icon}</span>{option.label}</button>)}
            </div>
          </div>
        </section>

        <section className="builder-card strategy-card">
          <div className="builder-title"><div><span>03</span><h2>执行策略</h2></div></div>
          <div className="form-label"><span>播放音量</span><div className="range-line"><input type="range" min="0" max="100" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /><b>{volume}%</b></div></div>
          <button className="button button-primary full-button" disabled={loading || !sourceReady || dispatchTargets.length === 0} onClick={() => setConfirm(true)}>开始广播</button>
        </section>
      </div>

      {confirm && sourceReady && <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirm(false)}><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setConfirm(false)}>×</button><div className="confirm-icon">◉</div><h2 id="confirm-title">确认开始广播？</h2><p>系统将呼叫所选在线终端并按队列顺序播放。</p><div className="confirm-facts"><div><span>播放队列</span><b>{selectedSourceRows.length} 项 / {selectedAudioCount} 个音频</b></div><div><span>广播内容</span><b>{selectedSourceName}</b></div><div><span>播放模式</span><b>{playModeLabel}</b></div><div><span>目标范围</span><b>{targetLabel || "未选择"}</b></div><div><span>覆盖终端</span><b>{dispatchTargets.length} 台在线终端</b></div><div><span>播放音量</span><b>{volume}%</b></div></div><div className="risk-note">确认后将立即开始广播，请核对目标范围、播放模式和播放顺序。</div>{submitError && <div className="permission-notice">{submitError}</div>}<div className="modal-actions"><button className="button button-secondary" disabled={submitting} onClick={() => setConfirm(false)}>取消</button><button className="button button-primary" disabled={submitting || !dispatchTargets.length} onClick={() => void startBroadcast()}>{submitting ? "正在下发…" : "确认并开始"}</button></div></div></div>}
    </div>
  );
}

function Schedule({ notify }: { notify: (message: string) => void }) {
  const [plans, setPlans] = useState<BackendSchedule[]>([]);
  const [scheduleZones, setScheduleZones] = useState<Array<{ id: string; name: string; terminalIds: string[] }>>([]);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [playlists, setPlaylists] = useState<MediaPlaylist[]>([]);
  const [terminals, setTerminals] = useState<LiveTerminal[]>([]);
  const [tab, setTab] = useState<"全部" | "已启用" | "已暂停">("全部");
  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [activePlan, setActivePlan] = useState<BackendSchedule | null>(null);
  const [deletePlan, setDeletePlan] = useState<BackendSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // 随机/循环配 0 分钟 = 一直播放，需要二次确认，避免误设成永不停止
  const [confirmEndless, setConfirmEndless] = useState(false);
  const [draft, setDraft] = useState<{ name: string; sources: Array<{ type: "FILE" | "PLAYLIST"; id: string }>; zoneIds: string[]; repeat: BackendSchedule["repeat"]; date: string; time: string; volume: number; playMode: BackendSchedule["playMode"]; durationMinutes: number }>({ name: "", sources: [], zoneIds: [], repeat: "ONCE", date: "", time: "", volume: 50, playMode: "ONCE", durationMinutes: 0 });

  const refresh = useCallback(async () => {
    try {
      const [schedulePayload, zonePayload, mediaPayload, terminalPayload, playlistPayload] = await Promise.all([
        apiRequest<{ items: BackendSchedule[] }>("/schedules"),
        apiRequest<{ items: Array<{ id: string; name: string; terminalIds: string[] }> }>("/zones"),
        apiRequest<{ items: MediaFile[] }>("/media/files"),
        apiRequest<{ items: LiveTerminal[] }>("/registrations"),
        apiRequest<{ items: MediaPlaylist[] }>("/media/playlists"),
      ]);
      setPlans(schedulePayload.items); setScheduleZones(zonePayload.items); setFiles(mediaPayload.items); setTerminals(terminalPayload.items); setPlaylists(playlistPayload.items); setError("");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "无法读取定时计划"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  const repeatLabels: Record<BackendSchedule["repeat"], string> = { ONCE: "单次", DAILY: "每天", WEEKDAYS: "工作日", WEEKLY: "每周" };
  const schedulePlayModeOptions = [
    { key: "ONCE", label: "单次播放", icon: "▶", hint: "按队列顺序播放一遍后结束" },
    { key: "LOOP", label: "循环播放", icon: "∞", hint: "循环播放，可设时长或一直播放" },
    { key: "SHUFFLE", label: "随机播放", icon: "⇄", hint: "每次执行都打乱队列顺序" },
  ] as const;
  const schedulePlayModeLabel = (mode: BackendSchedule["playMode"]) => schedulePlayModeOptions.find((option) => option.key === mode)?.label ?? "单次播放";
  // 播放时长：0 = 一直播放
  const minutesLabel = (minutes: number) => {
    if (!minutes) return "一直播放";
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  };
  // 播放时长仅对循环/随机有意义；单次播放按音频自身长度播完即止
  const durationLabel = (plan: BackendSchedule) => plan.playMode === "ONCE" ? "播完即止" : minutesLabel(plan.durationMinutes);
  // 计划绑定的播放内容（多选）；兼容仅有单个 mediaFileId 的旧计划
  const planSources = (plan: BackendSchedule) => {
    const items = plan.sources?.length ? plan.sources : plan.media ? [{ type: "FILE" as const, id: plan.media.id, name: plan.media.originalName, fileCount: 1, missing: false }] : [];
    return items;
  };
  const planSourceSummary = (plan: BackendSchedule) => {
    const items = planSources(plan);
    if (!items.length) return "内容已删除";
    return items.map((source) => source.name).join("、");
  };
  const resultLabel = (plan: BackendSchedule) => {
    if (plan.lastError) return `失败：${plan.lastError}`;
    if (!plan.lastBroadcast) return "尚未执行";
    const succeeded = plan.lastBroadcast.targets.filter((target) => target.state === "SUCCEEDED").length;
    const labels: Record<string, string> = { DISPATCHING: "下发中", RUNNING: plan.lastBroadcast.targets.some((target) => target.answeredAt) ? "播放中" : "呼叫中", SUCCEEDED: "成功", PARTIAL_FAILED: "部分成功", FAILED: "失败", CANCELED: "已停止" };
    return `${labels[plan.lastBroadcast.state] ?? plan.lastBroadcast.state} · ${succeeded}/${plan.lastBroadcast.targets.length}`;
  };
  const nextRunLabel = (plan: BackendSchedule) => plan.nextRunAt ? new Date(plan.nextRunAt).toLocaleString("zh-CN", { hour12: false }) : plan.enabled ? "等待计算" : plan.repeat === "ONCE" && plan.lastRunAt ? "已完成" : "已暂停";

  const visiblePlans = useMemo(() => plans.filter((plan) => {
    const matchesTab = tab === "全部" || (tab === "已启用" ? plan.enabled : !plan.enabled);
    const keyword = search.trim().toLowerCase();
    return matchesTab && (!keyword || `${plan.name} ${plan.id} ${planSourceSummary(plan)} ${plan.zones.map((zone) => zone.name).join(" ")}`.toLowerCase().includes(keyword));
  }), [plans, search, tab]);

  const openEditor = () => {
    const runAt = new Date(Date.now() + 5 * 60_000);
    setDraft({ name: "", sources: files[0] ? [{ type: "FILE", id: files[0].id }] : [], zoneIds: scheduleZones[0] ? [scheduleZones[0].id] : [], repeat: "ONCE", date: `${runAt.getFullYear()}-${String(runAt.getMonth() + 1).padStart(2, "0")}-${String(runAt.getDate()).padStart(2, "0")}`, time: `${String(runAt.getHours()).padStart(2, "0")}:${String(runAt.getMinutes()).padStart(2, "0")}`, volume: 50, playMode: "ONCE", durationMinutes: 0 });
    setEditorOpen(true);
  };
  const toggleTarget = (id: string) => setDraft((current) => ({ ...current, zoneIds: current.zoneIds.includes(id) ? current.zoneIds.filter((item) => item !== id) : [...current.zoneIds, id] }));
  const sourceSelected = (type: "FILE" | "PLAYLIST", id: string) => draft.sources.some((source) => source.type === type && source.id === id);
  const toggleSource = (type: "FILE" | "PLAYLIST", id: string) => setDraft((current) => {
    const exists = current.sources.some((source) => source.type === type && source.id === id);
    return { ...current, sources: exists ? current.sources.filter((source) => !(source.type === type && source.id === id)) : [...current.sources, { type, id }] };
  });
  const savePlan = async () => {
    if (!draft.name.trim() || !draft.zoneIds.length || !draft.sources.length) return;
    if (draft.playMode !== "ONCE" && !draft.durationMinutes && !confirmEndless) {
      setConfirmEndless(true);
      return;
    }
    setConfirmEndless(false);
    setSaving(true);
    try {
      const payloadBody = {
        ...draft,
        // 兼容字段：旧后端/旧数据使用单个 mediaFileId
        mediaFileId: draft.sources.length === 1 && draft.sources[0].type === "FILE" ? draft.sources[0].id : "",
        sourceItems: draft.sources,
      };
      const payload = await apiRequest<{ schedule: BackendSchedule }>("/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payloadBody) });
      setEditorOpen(false); notify(`定时计划“${payload.schedule.name}”已创建`); await refresh();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "计划创建失败"); }
    finally { setSaving(false); }
  };
  const toggleEnabled = async (plan: BackendSchedule) => {
    try { await apiRequest(`/schedules/${plan.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !plan.enabled }) }); notify(`计划“${plan.name}”已${plan.enabled ? "暂停" : "启用"}`); setActivePlan(null); await refresh(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "计划状态更新失败"); }
  };
  const removePlan = async () => {
    if (!deletePlan) return;
    setSaving(true);
    try { await apiRequest(`/schedules/${deletePlan.id}`, { method: "DELETE" }); notify(`计划“${deletePlan.name}”已删除`); setDeletePlan(null); setActivePlan(null); await refresh(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "计划删除失败"); }
    finally { setSaving(false); }
  };
  const today = new Date().toLocaleDateString("zh-CN");
  const todayCount = plans.filter((plan) => plan.enabled && plan.nextRunAt && new Date(plan.nextRunAt).toLocaleDateString("zh-CN") === today).length;

  return (
    <div className="page schedule-page">
      <div className="page-heading split-heading"><div><div className="breadcrumb">广播中心 / 定时计划</div><h1>定时计划</h1><p>创建单次或周期广播计划，设置执行时间、播放内容和目标分区。</p></div><div className="heading-actions"><button className="button button-secondary" disabled={loading} onClick={() => void refresh()}>↻ 刷新</button><button className="button button-primary" disabled={!files.length || !scheduleZones.length} onClick={openEditor}>＋ 新建计划</button></div></div>
      {error && <div className="media-error"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}

      <section className="schedule-stats">
        <div><span className="schedule-stat-icon blue">◷</span><p><b>{plans.length}</b><small>全部计划</small></p></div>
        <div><span className="schedule-stat-icon green">✓</span><p><b>{plans.filter((plan) => plan.enabled).length}</b><small>已启用</small></p></div>
        <div><span className="schedule-stat-icon violet">▦</span><p><b>{todayCount}</b><small>今日待执行</small></p></div>
        <div><span className="schedule-stat-icon orange">Ⅱ</span><p><b>{plans.filter((plan) => !plan.enabled).length}</b><small>已暂停</small></p></div>
      </section>

      <section className="panel schedule-panel">
        <div className="table-toolbar schedule-toolbar"><div className="tabs">{(["全部", "已启用", "已暂停"] as const).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}{item === "全部" ? ` ${plans.length}` : ""}</button>)}</div><div className="toolbar-actions"><label className="search-field compact"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索计划名称、编号或媒体" /></label><button className="button button-secondary small-button">筛选</button></div></div>
        <div className="table-scroll"><table className="data-table schedule-table"><thead><tr><th>计划名称 / 编号</th><th>执行周期</th><th>下次执行</th><th>目标分区</th><th>媒体内容</th><th>最近结果</th><th>状态</th><th>操作</th></tr></thead><tbody>{visiblePlans.map((plan) => { const terminalCount = new Set(plan.zones.flatMap((zone) => zone.terminalIds)).size; const result = resultLabel(plan); return <tr key={plan.id}><td><b>{plan.name}</b><small>{plan.id}</small></td><td><span className="repeat-tag">{repeatLabels[plan.repeat]}</span><small>{plan.repeat === "ONCE" ? plan.date : `${repeatLabels[plan.repeat]} ${plan.time}`}</small></td><td><b>{nextRunLabel(plan)}</b><small>音量 {plan.volume}%</small></td><td><b>{plan.zones.map((zone) => zone.name).join("、") || "分区已删除"}</b><small>{terminalCount} 台已配置终端</small></td><td><b>{planSourceSummary(plan)}</b><small>{schedulePlayModeLabel(plan.playMode)}{planSources(plan).length > 1 ? ` · ${planSources(plan).length} 项` : ""} · {durationLabel(plan)}</small></td><td><Status tone={result.startsWith("成功") ? "success" : result.startsWith("失败") ? "danger" : "neutral"}>{result}</Status></td><td><button className={`account-enable-switch ${plan.enabled ? "on" : ""}`} aria-label={`${plan.enabled ? "暂停" : "启用"}${plan.name}`} onClick={() => void toggleEnabled(plan)}><i /></button><small>{plan.enabled ? "已启用" : plan.repeat === "ONCE" && plan.lastRunAt ? "已完成" : "已暂停"}</small></td><td><button className="link-action" onClick={() => setActivePlan(plan)}>查看详情</button></td></tr>; })}</tbody></table></div>
        {visiblePlans.length === 0 && <div className="schedule-empty"><span>⌕</span><b>没有匹配的定时计划</b><button className="text-button" onClick={() => { setSearch(""); setTab("全部"); }}>清除筛选</button></div>}
        <div className="pagination"><span>共 {visiblePlans.length} 条计划</span><div><button disabled>‹</button><button className="active">1</button><button disabled>›</button></div></div>
      </section>

      {editorOpen && <div className="modal-backdrop" onMouseDown={() => setEditorOpen(false)}><div className="modal schedule-editor-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-editor-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setEditorOpen(false)}>×</button><div className="schedule-modal-heading"><span>◷</span><div><span className="section-kicker">定时广播</span><h2 id="schedule-editor-title">新建定时计划</h2><p>设置执行时间、播放内容和目标分区。</p></div></div><div className="schedule-form"><label className="wide"><span>计划名称 <em>*</em></span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：午间校园音乐" /></label><label className="wide"><span>播放内容 <em>*</em></span><div className="schedule-source-picker"><div className="source-group"><span className="source-group-label">音频文件</span><div className="source-chip-list">{files.map((file) => <button type="button" key={file.id} className={sourceSelected("FILE", file.id) ? "selected" : ""} onClick={() => toggleSource("FILE", file.id)}><i>{sourceSelected("FILE", file.id) ? "✓" : "+"}</i>{file.originalName}</button>)}{!files.length && <small className="source-group-empty">媒体库暂无音频</small>}</div></div><div className="source-group"><span className="source-group-label">播放列表</span><div className="source-chip-list">{playlists.map((playlist) => <button type="button" key={playlist.id} disabled={!playlist.files.length} className={sourceSelected("PLAYLIST", playlist.id) ? "selected" : ""} onClick={() => toggleSource("PLAYLIST", playlist.id)}><i>{sourceSelected("PLAYLIST", playlist.id) ? "✓" : "≡"}</i>{playlist.name}<em>{playlist.files.length} 个</em></button>)}{!playlists.length && <small className="source-group-empty">媒体库暂无播放列表</small>}</div></div></div>{draft.sources.length > 0 && <div className="schedule-queue-note">播放队列：{draft.sources.length} 项{draft.playMode === "SHUFFLE" ? "（随机播放，每次执行都会打乱顺序）" : draft.playMode === "LOOP" ? "（循环播放）" : ""}</div>}</label><label><span>执行周期</span><select value={draft.repeat} onChange={(event) => setDraft({ ...draft, repeat: event.target.value as BackendSchedule["repeat"] })}><option value="ONCE">单次</option><option value="DAILY">每天</option><option value="WEEKDAYS">工作日</option><option value="WEEKLY">每周</option></select></label><label><span>{draft.repeat === "ONCE" ? "执行日期" : "开始日期"} <em>*</em></span><input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label><label><span>执行时间 <em>*</em></span><input type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label><label className="wide"><span>目标分区 <em>*</em></span><div className="schedule-targets">{scheduleZones.map((zone) => { const online = terminals.filter((terminal) => zone.terminalIds.includes(terminal.id)).length; return <button type="button" key={zone.id} className={draft.zoneIds.includes(zone.id) ? "selected" : ""} onClick={() => toggleTarget(zone.id)}><i>{draft.zoneIds.includes(zone.id) ? "✓" : "+"}</i><span><b>{zone.name}</b><small>{online}/{zone.terminalIds.length} 台当前在线</small></span></button>; })}</div></label><div className="play-mode-block schedule-play-mode"><div className="play-mode-head"><span>播放模式</span><small>{schedulePlayModeOptions.find((option) => option.key === draft.playMode)?.hint}</small></div><div className="play-mode-tabs" role="radiogroup" aria-label="播放模式">{schedulePlayModeOptions.map((option) => <button type="button" role="radio" aria-checked={draft.playMode === option.key} className={draft.playMode === option.key ? "active" : ""} key={option.key} onClick={() => setDraft({ ...draft, playMode: option.key })}><span>{option.icon}</span>{option.label}</button>)}</div></div>{draft.playMode !== "ONCE" && <div className="schedule-duration-field"><span>播放时长</span><div className="duration-input"><input type="number" min="0" max="1440" step="5" value={draft.durationMinutes} onChange={(event) => setDraft({ ...draft, durationMinutes: Math.max(0, Math.min(1440, Math.floor(Number(event.target.value) || 0))) })} /><em>分钟</em></div><small>{draft.durationMinutes ? `播放 ${minutesLabel(draft.durationMinutes)} 后自动停止` : "设为 0 表示一直播放，直到手动停止"}</small></div>}<label className="wide schedule-volume"><span>播放音量 <b>{draft.volume}%</b></span><input type="range" min="0" max="100" value={draft.volume} onChange={(event) => setDraft({ ...draft, volume: Number(event.target.value) })} /></label></div><div className="schedule-form-note">时间按 Asia/Shanghai 执行；单次计划执行后自动转为已完成。</div><div className="modal-actions"><button className="button button-secondary" disabled={saving} onClick={() => setEditorOpen(false)}>取消</button><button className="button button-primary" disabled={saving || !draft.name.trim() || !draft.zoneIds.length || !draft.sources.length || !draft.date || !draft.time} onClick={() => void savePlan()}>{saving ? "正在创建…" : "创建计划"}</button></div></div></div>}

      {activePlan && <div className="modal-backdrop" onMouseDown={() => setActivePlan(null)}><div className="modal schedule-detail-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-detail-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setActivePlan(null)}>×</button><div className="schedule-detail-heading"><span>◷</span><div><div><span className="section-kicker">{activePlan.id}</span><Status tone={activePlan.enabled ? "success" : "neutral"}>{activePlan.enabled ? "已启用" : activePlan.repeat === "ONCE" && activePlan.lastRunAt ? "已完成" : "已暂停"}</Status></div><h2 id="schedule-detail-title">{activePlan.name}</h2><p>创建于 {new Date(activePlan.createdAt).toLocaleString("zh-CN", { hour12: false })}</p></div></div><div className="schedule-detail-grid"><div><span>播放内容</span><b>{planSourceSummary(activePlan)}</b>{planSources(activePlan).length > 1 && <small>{planSources(activePlan).length} 项</small>}</div><div><span>播放模式</span><b>{schedulePlayModeLabel(activePlan.playMode)}</b></div><div><span>播放时长</span><b>{durationLabel(activePlan)}</b></div><div><span>执行周期</span><b>{repeatLabels[activePlan.repeat]}</b></div><div><span>开始日期</span><b>{activePlan.date}</b></div><div><span>执行时间</span><b>{activePlan.time}</b></div><div><span>目标分区</span><b>{activePlan.zones.map((zone) => zone.name).join("、") || "分区已删除"}</b></div><div><span>播放音量</span><b>{activePlan.volume}%</b></div><div><span>下次执行</span><b>{nextRunLabel(activePlan)}</b></div><div><span>最近结果</span><b>{resultLabel(activePlan)}</b></div></div><section className="schedule-history"><div className="panel-title-row"><div><span className="section-kicker">执行记录</span><h3>最近执行</h3></div></div>{!activePlan.lastRunAt ? <p className="schedule-no-history">该计划尚无执行记录</p> : <div className="schedule-history-row"><span className="schedule-history-mark">✓</span><div><b>{new Date(activePlan.lastRunAt).toLocaleString("zh-CN", { hour12: false })}</b><small>{resultLabel(activePlan)}{activePlan.lastBroadcastId ? ` · 任务 ${activePlan.lastBroadcastId}` : ""}</small></div></div>}</section><div className="modal-actions"><button className="button button-danger-ghost" onClick={() => setDeletePlan(activePlan)}>删除计划</button><button className="button button-secondary" onClick={() => setActivePlan(null)}>关闭</button>{!(activePlan.repeat === "ONCE" && activePlan.lastRunAt) && <button className="button button-primary" onClick={() => void toggleEnabled(activePlan)}>{activePlan.enabled ? "暂停计划" : "启用计划"}</button>}</div></div></div>}
      {confirmEndless && <div className="modal-backdrop" onMouseDown={() => setConfirmEndless(false)}><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="endless-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setConfirmEndless(false)}>×</button><div className="confirm-icon">∞</div><h2 id="endless-title">播放时长设为 0，将一直播放</h2><p>该计划是{schedulePlayModeLabel(draft.playMode)}，播放时长为 0 表示会一直播放下去，直到你手动停止广播任务。确认要这样设置吗？</p><div className="modal-actions"><button className="button button-secondary" disabled={saving} onClick={() => setConfirmEndless(false)}>返回修改</button><button className="button button-primary" disabled={saving} onClick={() => void savePlan()}>{saving ? "正在创建…" : "确认一直播放"}</button></div></div></div>}
      {deletePlan && <div className="modal-backdrop" onMouseDown={() => setDeletePlan(null)}><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-schedule-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setDeletePlan(null)}>×</button><div className="confirm-icon danger-confirm">!</div><h2 id="delete-schedule-title">删除计划“{deletePlan.name}”？</h2><p>删除后计划将不再执行；已经产生的广播任务记录会保留。</p><div className="modal-actions"><button className="button button-secondary" disabled={saving} onClick={() => setDeletePlan(null)}>取消</button><button className="button button-danger-solid" disabled={saving} onClick={() => void removePlan()}>{saving ? "正在删除…" : "确认删除"}</button></div></div></div>}
    </div>
  );
}

function Terminals({ notify }: { notify: (message: string) => void }) {
  const [terminals, setTerminals] = useState<LiveTerminal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("全部状态");
  const [selectedZone, setSelectedZone] = useState("全部终端");
  const [showOffline, setShowOffline] = useState(true);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState("状态优先");
  const [view, setView] = useState<"cards" | "table">("cards");
  const [activeTerminal, setActiveTerminal] = useState<LiveTerminal | null>(null);
  const [renamingTerminal, setRenamingTerminal] = useState<{ id: string; name: string } | null>(null);

  const refreshTerminals = useCallback(async (showNotice = false) => {
    try {
      const payload = await apiRequest<{ items: LiveTerminal[]; updatedAt: string }>("/registrations");
      setTerminals(payload.items);
      setUpdatedAt(payload.updatedAt);
      setLoadError("");
      if (showNotice) notify(`已同步 ${payload.items.length} 台注册终端`);
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "终端列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshTerminals(), 0);
    const timer = window.setInterval(() => void refreshTerminals(), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refreshTerminals]);

  const visibleTerminals = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return terminals
      .filter((terminal) => selectedZone === "全部终端" || terminal.zone === selectedZone)
      .filter((terminal) => showOffline || terminal.status !== "离线")
      .filter((terminal) => statusFilter === "全部状态" || terminal.status === statusFilter)
      .filter((terminal) => !normalizedQuery || [terminal.name, terminal.id, terminal.extension, terminal.ip].some((value) => value.toLowerCase().includes(normalizedQuery)))
      .sort((a, b) => sortBy === "分机号" ? a.extension.localeCompare(b.extension) : sortBy === "终端名称" ? a.name.localeCompare(b.name, "zh-CN") : a.priority - b.priority);
  }, [query, selectedZone, showOffline, sortBy, statusFilter, terminals]);

  const onlineCount = terminals.length;
  const terminalZones = Array.from(new Set(terminals.map((terminal) => terminal.zone)));
  const toggleTerminal = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleMultiSelect = () => {
    setMultiSelect((current) => {
      if (current) setSelected([]);
      return !current;
    });
  };
  const runAction = (action: string, terminal: LiveTerminal) => {
    if (terminal.status === "离线" && action !== "查看详情") {
      notify(`${terminal.name} 当前离线，无法执行${action}`);
      return;
    }
    notify(`${action}指令已发送至 ${terminal.name}`);
  };
  const renameTerminal = async () => {
    if (!renamingTerminal?.name.trim()) return;
    try {
      await apiRequest(`/terminals/${encodeURIComponent(renamingTerminal.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: renamingTerminal.name }) });
      notify(`终端已重命名为“${renamingTerminal.name.trim()}”`);
      setRenamingTerminal(null);
      await refreshTerminals();
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "终端重命名失败");
    }
  };

  return (
    <div className="page terminals-page">
      <div className="page-heading split-heading">
        <div><div className="breadcrumb">运营管理 / 终端列表</div><h1>终端列表</h1><p>按分区快速查找 SIP 终端，查看实时状态并执行单点或批量广播操作。</p></div>
        <div className="heading-actions"><button className="button button-secondary" disabled={loading} onClick={() => void refreshTerminals(true)}>↻ {loading ? "同步中…" : "刷新状态"}</button><button className="button button-primary" disabled={!selected.length} onClick={() => notify(`已为 ${selected.length} 台终端创建批量广播任务`)}>◉ 发起广播{selected.length ? `（${selected.length}）` : ""}</button></div>
      </div>

      {loadError && <div className="media-error"><span>!</span>无法读取终端列表：{loadError}<button onClick={() => setLoadError("")}>×</button></div>}

      <section className="terminal-summary" aria-label="终端状态概览">
        <div><span className="terminal-summary-icon all">▤</span><span><small>全部终端</small><b>{terminals.length}</b></span></div>
        <div><span className="terminal-summary-icon online">●</span><span><small>在线可用</small><b>{onlineCount}</b></span></div>
        <div><span className="terminal-summary-icon playing">◉</span><span><small>正在播放</small><b>{terminals.filter((terminal) => terminal.status === "播放中").length}</b></span></div>
        <div><span className="terminal-summary-icon issue">!</span><span><small>异常 / 离线</small><b>0</b></span></div>
      </section>

      <section className="terminal-filter-panel" aria-label="终端筛选">
        <div className="terminal-filter-main">
          <label><span>运行状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>全部状态</option><option>在线空闲</option><option>播放中</option><option>异常</option><option>离线</option></select></label>
          <label className="terminal-search"><span>搜索终端</span><div className="search-field compact"><i>⌕</i><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称、SIP ID、分机号或 IP" /></div></label>
        </div>
        <div className="terminal-filter-tools">
          <label className="inline-switch"><span>显示离线</span><input type="checkbox" checked={showOffline} onChange={(event) => setShowOffline(event.target.checked)} /><i /></label>
          <label className="inline-switch"><span>多选</span><input type="checkbox" checked={multiSelect} onChange={toggleMultiSelect} /><i /></label>
          <label><span>排序</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option>状态优先</option><option>分机号</option><option>终端名称</option></select></label>
          <div className="view-switch" aria-label="视图切换"><button className={view === "cards" ? "active" : ""} onClick={() => setView("cards")} aria-label="卡片视图">▦</button><button className={view === "table" ? "active" : ""} onClick={() => setView("table")} aria-label="表格视图">☷</button></div>
        </div>
      </section>

      <div className="terminal-layout">
        <aside className="terminal-zone-panel">
          <div className="tree-heading"><div><span className="section-kicker">SIP 服务</span><b>注册终端</b></div><em>{onlineCount}/{terminals.length} 在线</em></div>
          <button className={selectedZone === "全部终端" ? "terminal-zone active" : "terminal-zone"} onClick={() => setSelectedZone("全部终端")}><span>⌂</span><b>全部终端</b><em>{terminals.length}</em></button>
          {terminalZones.map((zone) => {
            const zoneTerminals = terminals.filter((terminal) => terminal.zone === zone);
            return <button className={selectedZone === zone ? "terminal-zone active" : "terminal-zone"} key={zone} onClick={() => setSelectedZone(zone)}><span>⌘</span><b>{zone}</b><em>{zoneTerminals.length}/{zoneTerminals.length}</em></button>;
          })}
          <div className="terminal-zone-note"><span>●</span><div><b>每 5 秒同步</b><small>{updatedAt ? `最近更新：${new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "等待首次同步"}</small></div></div>
        </aside>

        <section className="terminal-results">
          <div className="terminal-results-head"><div><b>{selectedZone}</b><span>显示 {visibleTerminals.length} 台终端</span></div>{multiSelect && <div className="selection-actions"><span>已选 <b>{selected.length}</b> 台</span><button onClick={() => setSelected(Array.from(new Set([...selected, ...visibleTerminals.map((terminal) => terminal.id)])))}>全选当前</button><button onClick={() => setSelected((current) => visibleTerminals.filter((terminal) => !current.includes(terminal.id)).map((terminal) => terminal.id))}>反选</button><button onClick={() => setSelected([])}>清空</button></div>}</div>

          {!loading && visibleTerminals.length === 0 && <div className="terminal-empty"><span>⌕</span><h3>{terminals.length === 0 ? "暂无已注册终端" : "未找到匹配终端"}</h3><p>{terminals.length === 0 ? "当前没有 SIP 设备注册；设备注册成功后会自动出现在这里。" : "请调整搜索关键词、分区或状态筛选。"}</p>{terminals.length > 0 && <button className="text-button" onClick={() => { setQuery(""); setStatusFilter("全部状态"); setSelectedZone("全部终端"); setShowOffline(true); }}>清除筛选</button>}</div>}
          {loading && <div className="terminal-empty"><span>↻</span><h3>正在同步终端</h3><p>正在读取 SIP 注册信息。</p></div>}

          {view === "cards" && visibleTerminals.length > 0 && <div className="terminal-grid">{visibleTerminals.map((terminal) => {
            const isSelected = selected.includes(terminal.id);
            return <article className={`terminal-card ${isSelected ? "selected" : ""} ${terminal.status === "离线" ? "is-offline" : ""}`} key={terminal.id}>
              {multiSelect && <label className="terminal-check"><input type="checkbox" checked={isSelected} onChange={() => toggleTerminal(terminal.id)} aria-label={`选择 ${terminal.name}`} /><i>✓</i></label>}
              <div className="terminal-card-head"><span className={`terminal-device-icon ${terminal.type === "SIP 网关" ? "gateway" : ""}`}>{terminal.type === "SIP 网关" ? "GW" : "◖"}</span><div><b>{terminal.name}</b><small>{terminal.id}</small></div><Status tone={terminal.status === "在线空闲" || terminal.status === "播放中" ? "success" : terminal.status === "异常" ? "danger" : "neutral"}>{terminal.status}</Status></div>
              <div className="terminal-card-body"><div><span>所属分区</span><b>{terminal.zone} · {terminal.location}</b></div><div><span>SIP 分机号</span><b className="mono">{terminal.extension}</b></div><div><span>IP 地址</span><b className="mono">{terminal.ip}</b></div><div><span>终端能力</span><b>{terminal.capability}</b></div></div>
              <div className="terminal-card-foot"><span>最近通信：{terminal.last}</span><div><button onClick={() => runAction("单点广播", terminal)} disabled={terminal.status === "离线"}>◉<em>广播</em></button><button onClick={() => setRenamingTerminal({ id: terminal.id, name: terminal.name })}>✎<em>改名</em></button><button onClick={() => setActiveTerminal(terminal)}>···<em>详情</em></button></div></div>
            </article>;
          })}</div>}

          {view === "table" && visibleTerminals.length > 0 && <section className="panel terminal-table-panel"><div className="table-scroll"><table className="data-table terminal-table"><thead><tr>{multiSelect && <th>选择</th>}<th>终端名称</th><th>分机号</th><th>所属分区</th><th>IP 地址</th><th>状态</th><th>最近通信</th><th>操作</th></tr></thead><tbody>{visibleTerminals.map((terminal) => <tr key={terminal.id}>{multiSelect && <td><input type="checkbox" checked={selected.includes(terminal.id)} onChange={() => toggleTerminal(terminal.id)} aria-label={`选择 ${terminal.name}`} /></td>}<td><b>{terminal.name}</b><small>{terminal.id} · {terminal.type}</small></td><td className="mono">{terminal.extension}</td><td>{terminal.zone}<small>{terminal.location}</small></td><td className="mono">{terminal.ip}</td><td><Status tone={terminal.status === "在线空闲" || terminal.status === "播放中" ? "success" : terminal.status === "异常" ? "danger" : "neutral"}>{terminal.status}</Status></td><td>{terminal.last}</td><td><button className="link-action" onClick={() => runAction("单点广播", terminal)} disabled={terminal.status === "离线"}>广播</button><button className="link-action" onClick={() => setRenamingTerminal({ id: terminal.id, name: terminal.name })}>重命名</button><button className="link-action" onClick={() => setActiveTerminal(terminal)}>详情</button></td></tr>)}</tbody></table></div></section>}

          {visibleTerminals.length > 0 && <div className="terminal-pagination"><span>第 1 页，共 {visibleTerminals.length} 条</span><div><button disabled>‹</button><button className="active">1</button><button disabled>›</button></div></div>}
        </section>
      </div>

      {activeTerminal && <div className="modal-backdrop" onMouseDown={() => setActiveTerminal(null)}><div className="modal terminal-detail-modal" role="dialog" aria-modal="true" aria-labelledby="terminal-detail-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setActiveTerminal(null)}>×</button><div className="terminal-detail-heading"><span className={`terminal-device-icon ${activeTerminal.type === "SIP 网关" ? "gateway" : ""}`}>{activeTerminal.type === "SIP 网关" ? "GW" : "◖"}</span><div><span className="section-kicker">终端详情</span><h2 id="terminal-detail-title">{activeTerminal.name}</h2><p>{activeTerminal.id} · {activeTerminal.type}</p></div></div><div className="terminal-detail-grid"><div><span>运行状态</span><Status tone={activeTerminal.status === "在线空闲" || activeTerminal.status === "播放中" ? "success" : activeTerminal.status === "异常" ? "danger" : "neutral"}>{activeTerminal.status}</Status></div><div><span>SIP 分机号</span><b>{activeTerminal.extension}</b></div><div><span>所属分区</span><b>{activeTerminal.zone}</b></div><div><span>安装位置</span><b>{activeTerminal.location}</b></div><div><span>IP 地址</span><b>{activeTerminal.ip}</b></div><div><span>终端能力</span><b>{activeTerminal.capability}</b></div><div><span>最近通信</span><b>{activeTerminal.last}</b></div><div><span>配置状态</span><b>已同步</b></div></div><div className="modal-actions"><button className="button button-secondary" onClick={() => { runAction("监听", activeTerminal); setActiveTerminal(null); }}>◒ 发起监听</button><button className="button button-primary" disabled={activeTerminal.status === "离线"} onClick={() => { runAction("单点广播", activeTerminal); setActiveTerminal(null); }}>◉ 单点广播</button></div></div></div>}
      {renamingTerminal && <div className="modal-backdrop" onMouseDown={() => setRenamingTerminal(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="rename-terminal-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setRenamingTerminal(null)}>×</button><div className="confirm-icon">✎</div><h2 id="rename-terminal-title">修改终端名称</h2><p>修改后的名称会应用到终端列表和分区管理。</p><label className="modal-field"><span>终端名称 <em>*</em></span><input value={renamingTerminal.name} autoFocus maxLength={80} onChange={(event) => setRenamingTerminal({ ...renamingTerminal, name: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") void renameTerminal(); }} /><small>{renamingTerminal.name.length}/80</small></label><div className="modal-actions"><button className="button button-secondary" onClick={() => setRenamingTerminal(null)}>取消</button><button className="button button-primary" disabled={!renamingTerminal.name.trim()} onClick={() => void renameTerminal()}>保存名称</button></div></div></div>}
    </div>
  );
}

function SipAccounts({ notify }: { notify: (message: string) => void }) {
  const [accounts, setAccounts] = useState<SipAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [accountQuery, setAccountQuery] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("全部分组");
  const [registrationFilter, setRegistrationFilter] = useState("全部状态");
  const [newAccount, setNewAccount] = useState<{ account: string; name: string; displayNumber: string; password: string } | null>(null);
  const [deleteAccount, setDeleteAccount] = useState<SipAccount | null>(null);
  const [batchAccountText, setBatchAccountText] = useState<string | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sipServer, setSipServer] = useState({ host: "127.0.0.1", domain: "sip.local", port: 5060, transports: ["UDP", "TCP"] });

  const refreshAccounts = useCallback(async (showNotice = false) => {
    try {
      const payload = await apiRequest<{ items: SipAccount[]; updatedAt: string; server: { host: string; domain: string; port: number; transports: string[] } }>("/sip-accounts");
      setAccounts(payload.items);
      setSelectedAccounts((current) => current.filter((account) => payload.items.some((item) => item.account === account)));
      setUpdatedAt(payload.updatedAt);
      // SIP 服务器地址以后端返回为准（终端要注册的地址）；后端未返回时
      // 回退到浏览器当前主机名，最后兜底本机地址。
      setSipServer({ ...payload.server, host: payload.server.host || window.location.hostname || "127.0.0.1" });
      setLoadError("");
      if (showNotice) notify(`已同步 ${payload.items.length} 个 SIP 账号`);
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "SIP 账号加载失败");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshAccounts(), 0);
    const timer = window.setInterval(() => void refreshAccounts(), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refreshAccounts]);

  const departments = Array.from(new Set(accounts.map((account) => account.department))).sort();
  const filteredAccounts = useMemo(() => accounts.filter((account) => {
    const matchesName = !nameQuery.trim() || account.name.toLowerCase().includes(nameQuery.trim().toLowerCase());
    const matchesAccount = !accountQuery.trim() || [account.account, account.displayNumber].some((value) => value.includes(accountQuery.trim()));
    const matchesDepartment = departmentFilter === "全部分组" || account.department === departmentFilter;
    const matchesRegistration = registrationFilter === "全部状态" || account.registration === registrationFilter;
    return matchesName && matchesAccount && matchesDepartment && matchesRegistration;
  }), [accountQuery, accounts, departmentFilter, nameQuery, registrationFilter]);

  const onlineAccounts = accounts.filter((account) => account.registration === "在线").length;
  const parsedBatchAccounts = useMemo(() => {
    const rows = (batchAccountText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const items: Array<{ account: string; name: string; password: string; displayNumber: string }> = [];
    const errors: string[] = [];
    rows.forEach((row, index) => {
      const [account = "", name = "", password = "Sip@admin", displayNumber = ""] = row.split(/[，,\t]/).map((value) => value.trim());
      if (!/^[A-Za-z0-9_.-]{2,32}$/.test(account)) errors.push(`第 ${index + 1} 行：SIP 账号格式不正确`);
      if (!name || name.length > 80) errors.push(`第 ${index + 1} 行：账号名称不能为空`);
      if ((password || "Sip@admin").length < 6) errors.push(`第 ${index + 1} 行：密码至少需要 6 位`);
      items.push({ account, name, password: password || "Sip@admin", displayNumber: displayNumber || account });
    });
    const duplicate = items.find((item, index) => items.findIndex((candidate) => candidate.account === item.account) !== index);
    if (duplicate) errors.push(`账号 ${duplicate.account} 在导入内容中重复`);
    if (items.length > 200) errors.push("单次最多新增 200 个账号");
    return { items, errors };
  }, [batchAccountText]);
  const resetFilters = () => {
    setNameQuery("");
    setAccountQuery("");
    setDepartmentFilter("全部分组");
    setRegistrationFilter("全部状态");
  };

  const createAccount = async () => {
    if (!newAccount) return;
    setSaving(true);
    try {
      await apiRequest("/sip-accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newAccount) });
      notify(`SIP 账号 ${newAccount.account} 已创建并生效`);
      setNewAccount(null);
      await refreshAccounts();
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "SIP 账号创建失败");
    } finally {
      setSaving(false);
    }
  };

  const removeAccount = async () => {
    if (!deleteAccount) return;
    setSaving(true);
    try {
      await apiRequest(`/sip-accounts/${encodeURIComponent(deleteAccount.account)}`, { method: "DELETE" });
      notify(`SIP 账号 ${deleteAccount.account} 已删除`);
      setDeleteAccount(null);
      await refreshAccounts();
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "SIP 账号删除失败");
    } finally {
      setSaving(false);
    }
  };

  const createBatchAccounts = async () => {
    if (!parsedBatchAccounts.items.length || parsedBatchAccounts.errors.length) return;
    setSaving(true);
    try {
      await apiRequest("/sip-accounts/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: parsedBatchAccounts.items }) });
      notify(`已批量新增 ${parsedBatchAccounts.items.length} 个 SIP 账号`);
      setBatchAccountText(null);
      await refreshAccounts();
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "SIP 账号批量新增失败");
    } finally {
      setSaving(false);
    }
  };

  const removeBatchAccounts = async () => {
    if (!selectedAccounts.length) return;
    setSaving(true);
    try {
      await apiRequest("/sip-accounts/batch", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accounts: selectedAccounts }) });
      notify(`已批量删除 ${selectedAccounts.length} 个 SIP 账号`);
      setBatchDeleteOpen(false);
      setSelectedAccounts([]);
      await refreshAccounts();
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "SIP 账号批量删除失败");
    } finally {
      setSaving(false);
    }
  };

  const toggleSelectedAccount = (account: string) => setSelectedAccounts((current) => current.includes(account) ? current.filter((item) => item !== account) : [...current, account]);
  const allFilteredSelected = filteredAccounts.length > 0 && filteredAccounts.every((account) => selectedAccounts.includes(account.account));

  return (
    <div className="page sip-accounts-page">
      <div className="page-heading split-heading"><div><div className="breadcrumb">系统 / SIP 账号管理</div><h1>SIP 账号管理</h1><p>管理 SIP 账号并查看当前注册状态。</p></div><div className="heading-actions"><button className="button button-secondary" disabled={loading} onClick={() => void refreshAccounts(true)}>↻ {loading ? "同步中…" : "刷新"}</button><button className="button button-secondary" onClick={() => setBatchAccountText("")}>批量新增</button><button className="button button-primary" onClick={() => setNewAccount({ account: "", name: "", displayNumber: "", password: "Sip@admin" })}>＋ 新增账号</button></div></div>

      {loadError && <div className="media-error"><span>!</span>无法读取 SIP 账号：{loadError}<button onClick={() => setLoadError("")}>×</button></div>}
      <section className="sip-server-info" aria-label="SIP 服务器连接信息"><div><span className="sip-server-mark">SIP</span><div><small>服务器地址</small><b className="mono">{sipServer.host}:{sipServer.port}</b></div></div><div><small>SIP 域</small><b>{sipServer.domain}</b></div><div><small>传输协议</small><b>{sipServer.transports.join(" / ")}</b></div><button className="button button-secondary small-button" onClick={() => { void navigator.clipboard.writeText(`${sipServer.host}:${sipServer.port}`); notify("SIP 服务器地址已复制"); }}>复制地址</button></section>
      <div className="permission-notice">鉴权密码当前按要求以明文展示，仅用于本机终端注册配置，请勿截图、分享或用于生产环境。</div>

      <section className="sip-account-stats" aria-label="SIP 账号概览">
        <div><span>账号总数</span><b>{accounts.length}</b><small>SIP 注册账号</small></div>
        <div><span>目录已启用</span><b className="green">{accounts.filter((account) => account.enabled).length}</b><small>当前加载的有效账号</small></div>
        <div><span>在线注册</span><b className="green">{onlineAccounts}</b><small>注册率 {Math.round(onlineAccounts / Math.max(accounts.length, 1) * 100)}%</small></div>
        <div><span>当前未注册</span><b className="orange">{accounts.length - onlineAccounts}</b><small>{updatedAt ? `更新于 ${new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "等待首次同步"}</small></div>
      </section>

      <section className="panel sip-filter-panel">
        <div className="sip-filter-grid">
          <label><span>账号名称</span><input value={nameQuery} onChange={(event) => setNameQuery(event.target.value)} placeholder="请输入账号名称" /></label>
          <label><span>SIP 账号</span><input value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} placeholder="账号或显示号码" /></label>
          <label><span>目录分组</span><select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}><option>全部分组</option>{departments.map((department) => <option key={department}>{department}</option>)}</select></label>
          <label><span>注册状态</span><select value={registrationFilter} onChange={(event) => setRegistrationFilter(event.target.value)}><option>全部状态</option><option>在线</option><option>未注册</option></select></label>
          <div className="sip-filter-actions"><button className="button button-primary" onClick={() => notify(`已筛选出 ${filteredAccounts.length} 个 SIP 账号`)}>查询</button><button className="button button-secondary" onClick={resetFilters}>重置</button></div>
        </div>
      </section>

      <section className="panel sip-account-panel">
        <div className="sip-account-toolbar"><div><button className="button button-primary small-button" onClick={() => setNewAccount({ account: "", name: "", displayNumber: "", password: "Sip@admin" })}>＋ 新增</button><button className="button button-secondary small-button" onClick={() => setBatchAccountText("")}>批量新增</button><button className="button button-secondary small-button" onClick={() => notify(`当前共 ${filteredAccounts.length} 条可导出账号记录`)}>导出当前结果</button></div><span>共 {filteredAccounts.length} 条数据</span></div>
        {selectedAccounts.length > 0 && <div className="sip-batch-bar"><div><b>已选择 {selectedAccounts.length} 个账号</b><button onClick={() => setSelectedAccounts(filteredAccounts.map((account) => account.account))}>选择当前结果</button><button onClick={() => setSelectedAccounts([])}>取消选择</button></div><button className="button button-danger-solid small-button" onClick={() => setBatchDeleteOpen(true)}>批量删除</button></div>}
        <div className="table-scroll"><table className="data-table sip-account-table"><thead><tr><th><input type="checkbox" checked={allFilteredSelected} onChange={() => setSelectedAccounts(allFilteredSelected ? selectedAccounts.filter((account) => !filteredAccounts.some((item) => item.account === account)) : Array.from(new Set([...selectedAccounts, ...filteredAccounts.map((account) => account.account)])))} aria-label="全选当前账号" /></th><th>序号</th><th>账号类型</th><th>SIP 账号 / 名称</th><th>显示号码</th><th>域 / 上下文</th><th>鉴权密码（明文）</th><th>注册状态</th><th>目录分组</th><th>注册联系地址</th><th>操作</th></tr></thead><tbody>{filteredAccounts.map((account, index) => <tr className={selectedAccounts.includes(account.account) ? "selected-row" : ""} key={`${account.account}@${account.domain}`}><td><input type="checkbox" checked={selectedAccounts.includes(account.account)} onChange={() => toggleSelectedAccount(account.account)} aria-label={`选择账号 ${account.account}`} /></td><td>{index + 1}</td><td><span className="sip-type-badge">SIP</span><small>{account.transport}</small></td><td><b className="mono account-number">{account.account}</b><small>{account.name}</small></td><td className="mono">{account.displayNumber}</td><td><b>{account.domain}</b><small>{account.context}</small></td><td><div className="plain-credential"><code>{account.password || "未读取"}</code>{account.password && <button onClick={() => { void navigator.clipboard.writeText(account.password || ""); notify(`账号 ${account.account} 的鉴权密码已复制`); }}>复制</button>}</div></td><td><Status tone={account.registration === "在线" ? "success" : "neutral"}>{account.registration}</Status><small>{account.lastRegistered}</small></td><td>{account.department}</td><td className="mono">{account.registration === "在线" ? account.contact : "—"}</td><td><button className="danger-link" onClick={() => setDeleteAccount(account)}>删除</button></td></tr>)}</tbody></table></div>
        {!loading && filteredAccounts.length === 0 && <div className="sip-empty"><span>⌕</span><b>{accounts.length === 0 ? "当前没有有效 SIP 账号" : "没有匹配的 SIP 账号"}</b><p>{accounts.length === 0 ? "请新增账号或检查账号配置。" : "请调整查询条件后重试。"}</p>{accounts.length > 0 && <button className="text-button" onClick={resetFilters}>清除筛选</button>}</div>}
        {loading && <div className="sip-empty"><span>↻</span><b>正在同步 SIP 账号</b><p>正在读取账号目录与注册状态。</p></div>}
        <div className="pagination"><span>共 {filteredAccounts.length} 条数据</span><div><button disabled>‹</button><button className="active">1</button><button disabled>›</button></div></div>
      </section>

      {newAccount && <div className="modal-backdrop" onMouseDown={() => setNewAccount(null)}><div className="modal sip-editor-modal" role="dialog" aria-modal="true" aria-labelledby="new-sip-account-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setNewAccount(null)}>×</button><div className="sip-editor-heading"><span>#</span><div><span className="section-kicker">SIP 账号</span><h2 id="new-sip-account-title">新增 SIP 账号</h2><p>保存后账号立即生效，可用于终端注册。</p></div></div><div className="sip-editor-form"><label><span>SIP 账号 <em>*</em></span><input value={newAccount.account} autoFocus maxLength={32} onChange={(event) => setNewAccount({ ...newAccount, account: event.target.value.replace(/[^A-Za-z0-9_.-]/g, "") })} placeholder="例如 8001" /></label><label><span>账号名称 <em>*</em></span><input value={newAccount.name} maxLength={80} onChange={(event) => setNewAccount({ ...newAccount, name: event.target.value })} placeholder="例如 东门广播终端" /></label><label><span>显示号码</span><input value={newAccount.displayNumber} maxLength={32} onChange={(event) => setNewAccount({ ...newAccount, displayNumber: event.target.value.replace(/[^A-Za-z0-9_.-]/g, "") })} placeholder="默认与 SIP 账号一致" /></label><label><span>鉴权密码 <em>*</em></span><div className="password-input"><input type="text" value={newAccount.password} maxLength={128} onChange={(event) => setNewAccount({ ...newAccount, password: event.target.value })} /><button type="button" onClick={() => setNewAccount({ ...newAccount, password: `Sip${Math.random().toString(36).slice(2, 10)}!` })}>生成</button></div></label></div><div className="sip-security-note"><span>⌾</span><p>默认密码为 Sip@admin，可在创建前修改。</p></div><div className="modal-actions"><button className="button button-secondary" disabled={saving} onClick={() => setNewAccount(null)}>取消</button><button className="button button-primary" disabled={saving || newAccount.account.length < 2 || !newAccount.name.trim() || newAccount.password.length < 6} onClick={() => void createAccount()}>{saving ? "正在创建…" : "创建账号"}</button></div></div></div>}

      {batchAccountText !== null && <div className="modal-backdrop" onMouseDown={() => setBatchAccountText(null)}><div className="modal sip-editor-modal sip-batch-editor-modal" role="dialog" aria-modal="true" aria-labelledby="batch-sip-account-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setBatchAccountText(null)}>×</button><div className="sip-editor-heading"><span>≡</span><div><span className="section-kicker">批量操作</span><h2 id="batch-sip-account-title">批量新增 SIP 账号</h2><p>每行填写一个账号，单次最多新增 200 个。</p></div></div><label className="sip-batch-input"><span>账号内容 <em>*</em></span><textarea autoFocus value={batchAccountText} onChange={(event) => setBatchAccountText(event.target.value)} placeholder={`8001,东门广播终端,Sip@admin,8001\n8002,西门广播终端,Sip@admin,8002`} /><small>格式：SIP 账号，账号名称，鉴权密码，显示号码；密码和显示号码可省略。</small></label><div className={`sip-batch-preview ${parsedBatchAccounts.errors.length ? "has-error" : ""}`}><div><b>{parsedBatchAccounts.items.length}</b><span>待新增账号</span></div>{parsedBatchAccounts.errors.length > 0 ? <ul>{parsedBatchAccounts.errors.slice(0, 4).map((error) => <li key={error}>{error}</li>)}</ul> : <p>{parsedBatchAccounts.items.length ? "格式检查通过，提交后账号将立即生效。" : "请粘贴或输入账号内容。"}</p>}</div><div className="modal-actions"><button className="button button-secondary" disabled={saving} onClick={() => setBatchAccountText(null)}>取消</button><button className="button button-primary" disabled={saving || !parsedBatchAccounts.items.length || parsedBatchAccounts.errors.length > 0} onClick={() => void createBatchAccounts()}>{saving ? "正在新增…" : `新增 ${parsedBatchAccounts.items.length} 个账号`}</button></div></div></div>}

      {deleteAccount && <div className="modal-backdrop" onMouseDown={() => setDeleteAccount(null)}><div className="modal confirm-modal sip-delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-sip-account-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setDeleteAccount(null)}>×</button><div className="confirm-icon danger-confirm">!</div><h2 id="delete-sip-account-title">删除 SIP 账号 {deleteAccount.account}？</h2><p>账号删除后将立即失效。</p>{deleteAccount.registration === "在线" && <div className="risk-note">该账号当前在线，删除会清除其注册并阻止再次登录。</div>}<div className="modal-actions"><button className="button button-secondary" disabled={saving} onClick={() => setDeleteAccount(null)}>取消</button><button className="button button-danger-solid" disabled={saving} onClick={() => void removeAccount()}>{saving ? "正在删除…" : "确认删除"}</button></div></div></div>}
      {batchDeleteOpen && <div className="modal-backdrop" onMouseDown={() => setBatchDeleteOpen(false)}><div className="modal confirm-modal sip-delete-modal" role="dialog" aria-modal="true" aria-labelledby="batch-delete-sip-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setBatchDeleteOpen(false)}>×</button><div className="confirm-icon danger-confirm">!</div><h2 id="batch-delete-sip-title">删除选中的 {selectedAccounts.length} 个 SIP 账号？</h2><p>账号删除后将立即失效，已注册的终端会被断开。</p><div className="batch-delete-list">{selectedAccounts.slice(0, 8).map((account) => <span key={account}>{account}</span>)}{selectedAccounts.length > 8 && <em>另有 {selectedAccounts.length - 8} 个账号</em>}</div><div className="modal-actions"><button className="button button-secondary" disabled={saving} onClick={() => setBatchDeleteOpen(false)}>取消</button><button className="button button-danger-solid" disabled={saving} onClick={() => void removeBatchAccounts()}>{saving ? "正在删除…" : `确认删除 ${selectedAccounts.length} 个账号`}</button></div></div></div>}
    </div>
  );
}

// 分区号码：拨打该号码即对分区内所有终端发起群呼（实时喊话）。
// 6xxxx 号段由后端分配，与个人分机（4 位 1xxx）及 FreeSWITCH 样例号码区分开。
type ManagedZone = { id: string; name: string; number?: string; terminalIds: string[]; createdAt: string };


function Resources({ role, organizationName, onOrganizationSave, notify }: { role: Role; organizationName: string; onOrganizationSave: (name: string) => void; notify: (message: string) => void }) {
  const [managedZones, setManagedZones] = useState<ManagedZone[]>([]);
  const [managedTerminals, setManagedTerminals] = useState<LiveTerminal[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState<string | "all" | "unassigned">("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [zoneEditor, setZoneEditor] = useState<{ id?: string; name: string; number: string } | null>(null);
  const [assignmentZone, setAssignmentZone] = useState<ManagedZone | null>(null);
  const [assignedIds, setAssignedIds] = useState<string[]>([]);
  const [deleteZone, setDeleteZone] = useState<ManagedZone | null>(null);
  const [organizationEditor, setOrganizationEditor] = useState<string | null>(null);

  const refreshResources = useCallback(async () => {
    try {
      const [zonePayload, terminalPayload] = await Promise.all([
        apiRequest<{ items: ManagedZone[] }>("/zones"),
        apiRequest<{ items: LiveTerminal[] }>("/registrations"),
      ]);
      setManagedZones(zonePayload.items);
      setManagedTerminals(terminalPayload.items);
      setLoadError("");
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "分区资源加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshResources(), 0);
    const timer = window.setInterval(() => void refreshResources(), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refreshResources]);

  const selectedZone = managedZones.find((zone) => zone.id === selectedZoneId);
  const visibleTerminals = useMemo(() => managedTerminals.filter((terminal) => {
    const matchesZone = selectedZoneId === "all" || (selectedZoneId === "unassigned" ? terminal.zone === "未分配" : terminal.zone === selectedZone?.name);
    const keyword = search.trim().toLowerCase();
    return matchesZone && (!keyword || [terminal.name, terminal.id, terminal.extension, terminal.ip].some((value) => value.toLowerCase().includes(keyword)));
  }), [managedTerminals, search, selectedZone, selectedZoneId]);

  const saveZone = async () => {
    if (!zoneEditor?.name.trim()) return;
    try {
      // 号码留空时由后端自动从 9 号段分配
      const payload: { name: string; number?: string } = { name: zoneEditor.name.trim() };
      if (zoneEditor.number.trim()) payload.number = zoneEditor.number.trim();
      await apiRequest(zoneEditor.id ? `/zones/${zoneEditor.id}` : "/zones", { method: zoneEditor.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (zoneEditor.id) {
        notify(`分区“${zoneEditor.name.trim()}”已更新`);
      } else {
        notify(`分区“${zoneEditor.name.trim()}”已创建`);
      }
      setZoneEditor(null);
      await refreshResources();
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "分区保存失败");
    }
  };

  const openAssignments = (zone: ManagedZone) => {
    setAssignmentZone(zone);
    setAssignedIds([...zone.terminalIds]);
  };

  const saveAssignments = async () => {
    if (!assignmentZone) return;
    try {
      await apiRequest(`/zones/${assignmentZone.id}/terminals`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terminalIds: assignedIds }) });
      notify(`“${assignmentZone.name}”已配置 ${assignedIds.length} 台终端`);
      setAssignmentZone(null);
      await refreshResources();
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "终端归属保存失败");
    }
  };

  const confirmDeleteZone = async () => {
    if (!deleteZone) return;
    try {
      await apiRequest(`/zones/${deleteZone.id}`, { method: "DELETE" });
      notify(`分区“${deleteZone.name}”已删除，相关终端已转为未分配`);
      if (selectedZoneId === deleteZone.id) setSelectedZoneId("all");
      setDeleteZone(null);
      await refreshResources();
    } catch (requestError) {
      setLoadError(requestError instanceof Error ? requestError.message : "分区删除失败");
    }
  };

  const assignedCount = managedTerminals.filter((terminal) => terminal.zone !== "未分配").length;

  return <div className="page zone-management-page">
    <div className="page-heading split-heading"><div><div className="breadcrumb">资源管理 / 分区管理</div><h1>分区管理</h1><p>管理广播分区并配置终端归属。</p></div><div className="heading-actions"><button className="button button-secondary" disabled={loading} onClick={() => void refreshResources()}>↻ 刷新</button><button className="button button-primary" disabled={role !== "系统管理员"} onClick={() => setZoneEditor({ name: "", number: "" })}>＋ 新建分区</button></div></div>
    {loadError && <div className="media-error"><span>!</span>{loadError}<button onClick={() => setLoadError("")}>×</button></div>}
    {role !== "系统管理员" && <div className="permission-notice">当前为只读模式，请切换为系统管理员后修改分区配置。</div>}
    <section className="organization-banner"><div className="organization-banner-mark">{organizationName.slice(0, 2)}</div><div><span>当前组织</span><h2>{organizationName}</h2><p>{managedZones.length} 个分区 · {managedTerminals.length} 台注册终端</p></div><button className="text-button" disabled={role !== "系统管理员"} onClick={() => setOrganizationEditor(organizationName)}>修改组织名称</button></section>
    <section className="zone-overview-grid"><div><span>广播分区</span><b>{managedZones.length}</b><small>已配置分区</small></div><div><span>已分配终端</span><b>{assignedCount}</b><small>共 {managedTerminals.length} 台在线终端</small></div><div><span>在线终端</span><b className="green">{managedTerminals.length}</b><small>SIP 注册终端</small></div><div><span>未分配终端</span><b className="orange">{managedTerminals.length - assignedCount}</b><small>可配置到任一分区</small></div></section>

    <div className="zone-management-layout">
      <aside className="panel managed-zone-list"><div className="managed-zone-heading"><div><span className="section-kicker">分区列表</span><h2>广播分区</h2></div><button disabled={role !== "系统管理员"} onClick={() => setZoneEditor({ name: "", number: "" })}>＋</button></div>
        <button className={`managed-zone-item ${selectedZoneId === "all" ? "active" : ""}`} onClick={() => setSelectedZoneId("all")}><span className="zone-folder root">⌂</span><span><b>全部终端</b><small>当前已注册</small></span><em>{managedTerminals.length}</em></button>
        {managedZones.map((zone) => <button className={`managed-zone-item ${selectedZoneId === zone.id ? "active" : ""}`} key={zone.id} onClick={() => setSelectedZoneId(zone.id)}><span className="zone-folder">▰</span><span><b>{zone.name}</b><small>群呼号码 {zone.number ?? "—"}</small></span><em>{zone.terminalIds.length}</em></button>)}
        <button className={`managed-zone-item unassigned ${selectedZoneId === "unassigned" ? "active" : ""}`} onClick={() => setSelectedZoneId("unassigned")}><span className="zone-folder">?</span><span><b>未分配终端</b><small>尚未加入任何分区</small></span><em>{managedTerminals.length - assignedCount}</em></button>
      </aside>

      <section className="panel zone-terminal-panel"><div className="zone-terminal-heading"><div><span className="section-kicker">{selectedZone ? "分区详情" : "终端总览"}</span><h2>{selectedZone?.name ?? (selectedZoneId === "unassigned" ? "未分配终端" : organizationName)}</h2><p>{selectedZone ? `已配置 ${selectedZone.terminalIds.length} 台终端` : "查看终端注册与运行状态"}</p></div>{selectedZone && <div className="zone-heading-actions">{selectedZone.number && <span className="zone-dial-badge" title="用任意 SIP 终端拨打该号码即可对分区内全部终端群呼">☎ 群呼号码 <b>{selectedZone.number}</b></span>}<button className="button button-secondary small-button" disabled={role !== "系统管理员"} onClick={() => setZoneEditor({ id: selectedZone.id, name: selectedZone.name, number: selectedZone.number ?? "" })}>编辑</button><button className="button button-primary small-button" disabled={role !== "系统管理员"} onClick={() => openAssignments(selectedZone)}>配置终端</button><button className="zone-delete-button" disabled={role !== "系统管理员"} onClick={() => setDeleteZone(selectedZone)}>删除</button></div>}</div>
        <div className="zone-terminal-toolbar"><label className="search-field compact"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索终端名称、分机或 IP" /></label><span>当前显示 {visibleTerminals.length} 台</span></div>
        <div className="table-scroll"><table className="data-table managed-terminal-table"><thead><tr><th>终端名称 / SIP ID</th><th>SIP 分机</th><th>传输</th><th>所属分区</th><th>联系地址</th><th>IP 地址</th><th>状态</th></tr></thead><tbody>{visibleTerminals.map((terminal) => <tr key={terminal.id}><td><b>{terminal.name}</b><small>{terminal.id}</small></td><td className="mono">{terminal.extension}</td><td>{terminal.transport}</td><td><span className={terminal.zone === "未分配" ? "unassigned-tag" : "zone-name-tag"}>{terminal.zone}</span></td><td>{terminal.location}</td><td className="mono">{terminal.ip}</td><td><Status tone="success">{terminal.status}</Status></td></tr>)}</tbody></table></div>
        {!loading && visibleTerminals.length === 0 && <div className="zone-terminal-empty"><span>▰</span><b>{managedTerminals.length === 0 ? "暂无注册终端" : "该范围内暂无终端"}</b><p>{managedTerminals.length === 0 ? "SIP 终端注册后会自动出现在这里" : "可点击“配置终端”调整归属"}</p></div>}
        {loading && <div className="zone-terminal-empty"><span>↻</span><b>正在读取分区与终端</b></div>}
        <div className="pagination"><span>共 {visibleTerminals.length} 台终端</span><div><button disabled>‹</button><button className="active">1</button><button disabled>›</button></div></div>
      </section>
    </div>

    {organizationEditor !== null && <div className="modal-backdrop" onMouseDown={() => setOrganizationEditor(null)}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setOrganizationEditor(null)}>×</button><div className="confirm-icon">⌂</div><h2>修改组织名称</h2><label className="modal-field"><span>组织名称</span><input value={organizationEditor} autoFocus maxLength={30} onChange={(event) => setOrganizationEditor(event.target.value)} /></label><div className="modal-actions"><button className="button button-secondary" onClick={() => setOrganizationEditor(null)}>取消</button><button className="button button-primary" disabled={!organizationEditor.trim()} onClick={() => { onOrganizationSave(organizationEditor.trim()); notify("组织名称已更新"); setOrganizationEditor(null); }}>保存</button></div></div></div>}
    {zoneEditor && <div className="modal-backdrop" onMouseDown={() => setZoneEditor(null)}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setZoneEditor(null)}>×</button><div className="confirm-icon">▰</div><h2>{zoneEditor.id ? "编辑分区" : "新建分区"}</h2><p>分区号码用于群呼：用任意 SIP 终端拨打该号码，即可对分区内全部终端发起实时喊话。</p><label className="modal-field"><span>分区名称 <em>*</em></span><input value={zoneEditor.name} autoFocus maxLength={40} onChange={(event) => setZoneEditor({ ...zoneEditor, name: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") void saveZone(); }} /></label><label className="modal-field"><span>分区号码（6 开头 5 位）</span><input value={zoneEditor.number} inputMode="numeric" maxLength={5} placeholder={zoneEditor.id ? "" : "留空自动分配"} onChange={(event) => setZoneEditor({ ...zoneEditor, number: event.target.value.replace(/\D/g, "").slice(0, 5) })} onKeyDown={(event) => { if (event.key === "Enter") void saveZone(); }} /></label>{(zoneEditor.number.length > 0 && zoneEditor.number.length < 5) && <p className="modal-hint">号码需填满 5 位；留空则由系统自动分配。</p>}{zoneEditor.number.length === 5 && !/^6\d{4}$/.test(zoneEditor.number) && <p className="modal-hint">请使用 60000-69999 之间的号码。</p>}<div className="modal-actions"><button className="button button-secondary" onClick={() => setZoneEditor(null)}>取消</button><button className="button button-primary" disabled={!zoneEditor.name.trim() || (zoneEditor.number.length > 0 && !/^6\d{4}$/.test(zoneEditor.number))} onClick={() => void saveZone()}>保存</button></div></div></div>}
    {assignmentZone && <div className="modal-backdrop" onMouseDown={() => setAssignmentZone(null)}><div className="modal zone-assignment-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setAssignmentZone(null)}>×</button><div className="zone-assignment-heading"><span>▦</span><div><span className="section-kicker">终端归属</span><h2>配置“{assignmentZone.name}”</h2><p>每台终端只能属于一个分区。</p></div></div><div className="assignment-summary"><span>已选择 <b>{assignedIds.length}</b> 台</span><button className="text-button" onClick={() => setAssignedIds(managedTerminals.map((terminal) => terminal.id))}>全选</button><button className="text-button" onClick={() => setAssignedIds([])}>清空</button></div><div className="assignment-terminal-list">{managedTerminals.length === 0 ? <div className="media-picker-empty">当前没有已注册终端</div> : managedTerminals.map((terminal) => <label key={terminal.id} className={assignedIds.includes(terminal.id) ? "selected" : ""}><input type="checkbox" checked={assignedIds.includes(terminal.id)} onChange={() => setAssignedIds((current) => current.includes(terminal.id) ? current.filter((id) => id !== terminal.id) : [...current, terminal.id])} /><span className="terminal-device-icon">◖</span><span><b>{terminal.name}</b><small>{terminal.extension} · {terminal.ip}</small></span><em>{terminal.zone}</em></label>)}</div><div className="modal-actions"><button className="button button-secondary" onClick={() => setAssignmentZone(null)}>取消</button><button className="button button-primary" onClick={() => void saveAssignments()}>保存终端配置</button></div></div></div>}
    {deleteZone && <div className="modal-backdrop" onMouseDown={() => setDeleteZone(null)}><div className="modal confirm-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setDeleteZone(null)}>×</button><div className="confirm-icon danger-confirm">!</div><h2>删除“{deleteZone.name}”？</h2><p>分区将从后端永久删除，其中终端会自动转为未分配，不会删除 SIP 账号。</p><div className="modal-actions"><button className="button button-secondary" onClick={() => setDeleteZone(null)}>取消</button><button className="button button-danger-solid" onClick={() => void confirmDeleteZone()}>确认删除</button></div></div></div>}
  </div>;
}

function Tasks() {
  const [tab, setTab] = useState<"全部任务" | "进行中" | "异常" | "已完成">("全部任务");
  const [broadcasts, setBroadcasts] = useState<BackendBroadcast[]>([]);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  // 播放中任务的音量滑动值：拖动时本地即时反馈，停止拖动后再写回后端。
  const [volumeDrafts, setVolumeDrafts] = useState<Record<string, number>>({});
  // 正在提交「重发」的任务 ID，用于禁用按钮防重复点击。
  const [replaying, setReplaying] = useState<string | null>(null);
  // 音量请求的防抖定时器，按任务 ID 分别持有。
  const volumeTimers = useRef<Record<string, number>>({});
  const refresh = useCallback(async () => {
    try {
      const payload = await apiRequest<{ items: BackendBroadcast[] }>("/broadcasts");
      setBroadcasts(payload.items);
      setLoadError("");
      // 服务端已成为权威值后，清理已被接管（或已结束）任务的本地草稿，
      // 避免轮询回来的新数据被旧草稿覆盖。
      setVolumeDrafts((current) => {
        const next = { ...current };
        let changed = false;
        for (const id of Object.keys(next)) {
          const broadcast = payload.items.find((item) => item.id === id);
          if (!broadcast || completedTaskStates.has(broadcast.state)) { delete next[id]; changed = true; }
        }
        return changed ? next : current;
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "无法读取任务");
    }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    // 在 effect 建立时把 ref 的当前值取出来：清理函数运行时机晚于组件卸载，
    // 届时 volumeTimers.current 可能已指向新的对象，直接读取会漏掉旧定时器。
    const timers = volumeTimers.current;
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      // 卸载时清掉待发的音量请求，避免对已关闭页面写入。
      Object.values(timers).forEach((pending) => window.clearTimeout(pending));
    };
  }, [refresh]);
  const cancel = async (id: string) => {
    await apiRequest(`/broadcasts/${id}/cancel`, { method: "POST" });
    await refresh();
  };
  const commitVolume = useCallback(async (id: string, volume: number) => {
    try {
      await apiRequest(`/broadcasts/${id}/volume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volume }),
      });
      setNotice(`音量已调整为 ${volume}%`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "音量调整失败");
      // 失败时以服务端为准回滚本地草稿。
      setVolumeDrafts((current) => { const next = { ...current }; delete next[id]; return next; });
      await refresh();
    }
  }, [refresh]);
  const changeVolume = (id: string, volume: number) => {
    setVolumeDrafts((current) => ({ ...current, [id]: volume }));
    window.clearTimeout(volumeTimers.current[id]);
    volumeTimers.current[id] = window.setTimeout(() => { void commitVolume(id, volume); }, 350);
  };
  const replay = async (id: string) => {
    setReplaying(id);
    try {
      const payload = await apiRequest<{ broadcast: BackendBroadcast }>(`/broadcasts/${id}/replay`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      setNotice(`已重新发起广播，正在向 ${payload.broadcast.targets.length} 台终端下发`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重发失败");
    } finally {
      setReplaying(null);
    }
  };
  const stateLabel = (broadcast: BackendBroadcast) => ({ DISPATCHING: "下发中", RUNNING: broadcast.targets.some((target) => target.answeredAt) ? "播放中" : "呼叫中", SUCCEEDED: "成功", PARTIAL_FAILED: "部分成功", FAILED: "失败", CANCELED_REQUESTED: "停止中", CANCELED: "已停止" } as Record<string, string>)[broadcast.state] ?? broadcast.state;
  const liveRows = broadcasts.map((broadcast) => {
    const completed = broadcast.targets.filter((target) => ["SUCCEEDED", "FAILED", "CANCELED"].includes(target.state)).length;
    return { id: broadcast.id, name: broadcast.name, type: broadcast.type === "PRESET" ? "预设广播" : broadcast.name.startsWith("定时广播 ·") ? "定时广播" : "实时广播", target: `${broadcast.targets.length} 台终端`, progress: `${completed} / ${broadcast.targets.length}`, status: stateLabel(broadcast), time: new Date(broadcast.createdAt).toLocaleString("zh-CN", { hour12: false }), state: broadcast.state, replayOfId: broadcast.replayOfId ?? null, volume: volumeDrafts[broadcast.id] ?? broadcast.volume ?? 50 };
  });
  const rows = liveRows.filter((row) => (tab === "全部任务" || (tab === "进行中" && activeTaskStates.has(row.state)) || (tab === "异常" && failedTaskStates.has(row.state)) || (tab === "已完成" && completedTaskStates.has(row.state))) && (!query.trim() || `${row.name} ${row.id}`.toLowerCase().includes(query.trim().toLowerCase())));
  const allTargets = broadcasts.flatMap((broadcast) => broadcast.targets);
  const successTargets = allTargets.filter((target) => target.state === "SUCCEEDED").length;
  const failedTargets = allTargets.filter((target) => target.state === "FAILED").length;
  const pendingTargets = allTargets.length - successTargets - failedTargets - allTargets.filter((target) => target.state === "CANCELED").length;
  const successRate = allTargets.length ? (successTargets / allTargets.length * 100).toFixed(1) : "0.0";
  // 环形图扇区比例：按真实终端结果计算累计百分比端点，经 CSS 变量注入。
  // 顺序为 成功 → 执行中/未确认 → 失败，剩余部分（已取消）由 CSS 以灰色补齐。
  const donutPercent = (count: number) => (allTargets.length ? (count / allTargets.length) * 100 : 0);
  const donutSuccessEnd = donutPercent(successTargets);
  const donutPendingEnd = donutSuccessEnd + donutPercent(pendingTargets);
  const donutFailedEnd = donutPendingEnd + donutPercent(failedTargets);
  const donutStyle = {
    "--donut-success": `${donutSuccessEnd}%`,
    "--donut-pending": `${donutPendingEnd}%`,
    "--donut-failed": `${donutFailedEnd}%`,
  } as CSSProperties;
  const causes = Object.entries(allTargets.filter((target) => target.failureCause).reduce<Record<string, number>>((result, target) => { const cause = target.failureCause || "UNKNOWN"; result[cause] = (result[cause] ?? 0) + 1; return result; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return <div className="page"><div className="page-heading split-heading"><div><div className="breadcrumb">广播中心 / 任务中心</div><h1>任务中心</h1><p>统一查看广播记录、终端执行结果和异常原因。</p></div><button className="button button-secondary" onClick={() => void refresh()}>↻ 刷新</button></div>
    {loadError && <div className="media-error"><span>!</span>任务数据读取失败：{loadError}</div>}
    {notice && <div className="task-notice"><span>ℹ</span>{notice}<button onClick={() => setNotice("")}>×</button></div>}
    <section className="panel tasks-card"><div className="table-toolbar"><div className="tabs">{(["全部任务", "进行中", "异常", "已完成"] as const).map((item) => <button key={item} onClick={() => setTab(item)} className={tab === item ? "active" : ""}>{item}{item === "全部任务" ? ` ${broadcasts.length}` : item === "进行中" ? ` ${broadcasts.filter((broadcast) => activeTaskStates.has(broadcast.state)).length}` : item === "异常" ? ` ${broadcasts.filter((broadcast) => failedTaskStates.has(broadcast.state)).length}` : ` ${broadcasts.filter((broadcast) => completedTaskStates.has(broadcast.state)).length}`}</button>)}</div><div className="toolbar-actions"><label className="search-field compact"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务名称或编号" /></label></div></div>
    <div className="table-scroll"><table className="data-table task-table"><thead><tr><th>任务 / 编号</th><th>类型</th><th>目标范围</th><th>设备结果</th><th>状态</th><th>发起时间</th><th>音量</th><th>操作</th></tr></thead><tbody>{rows.map((row) => {
      const live = !completedTaskStates.has(row.state);
      return <tr key={row.id}><td><b>{row.name}</b><small>{row.id}{row.replayOfId ? " · 重发任务" : ""}</small></td><td>{row.type}</td><td>{row.target}</td><td><div className="result-progress"><span><i style={{ width: `${parseInt(row.progress) / Math.max(1, parseInt(row.progress.split("/")[1])) * 100}%` }} /></span><b>{row.progress}</b></div></td><td><Status tone={row.status === "播放中" || row.status === "成功" ? "success" : row.status === "失败" ? "danger" : "warning"}>{row.status}</Status></td><td>{row.time}</td><td>{live ? <div className="task-volume"><input type="range" min="0" max="100" value={row.volume} aria-label={`调整「${row.name}」的音量`} onChange={(event) => changeVolume(row.id, Number(event.target.value))} /><b>{row.volume}%</b></div> : <span className="task-volume-static">{row.volume}%</span>}</td><td><div className="task-actions">{live ? <button className="link-action" onClick={() => void cancel(row.id)}>停止</button> : <button className="link-action" disabled={replaying === row.id} onClick={() => void replay(row.id)}>{replaying === row.id ? "重发中…" : "重发"}</button>}</div></td></tr>;
    })}</tbody></table></div>{rows.length === 0 && <div className="schedule-empty"><b>没有符合条件的任务</b></div>}</section>
    <div className="task-insight-grid"><section className="panel"><span className="section-kicker">执行质量</span><h2>全部终端结果</h2><div className="donut-row"><div className="donut" style={donutStyle}><span>{successRate}%<small>成功率</small></span></div><div className="legend-list"><div><i className="green-bg" />成功确认<b>{successTargets}</b></div><div><i className="orange-bg" />执行中 / 未确认<b>{pendingTargets}</b></div><div><i className="red-bg" />失败<b>{failedTargets}</b></div></div></div></section><section className="panel"><span className="section-kicker">异常分析</span><h2>失败原因分布</h2><div className="reason-bars">{causes.map(([cause, count]) => { const meta = getFailureCauseMeta(cause); return <div key={cause} title={`原因码：${cause}`}><span><b>{meta.label}</b><small>{meta.description}</small></span><i><b style={{ width: `${count / Math.max(1, failedTargets) * 100}%` }} /></i><em>{count} 次</em></div>; })}{causes.length === 0 && <p className="schedule-no-history">当前没有异常记录，终端运行正常</p>}</div></section></div>
  </div>;
}

// 快捷入口瓦片的色调：循环取用，让一屏入口有视觉区分而不是一片同色。
// 只用已有 CSS 变量定义（见 globals.css 的 .shortcut-tile.tone-*），不硬编码颜色。
const SHORTCUT_TONES = 4;

function Shortcuts({ go }: { go: (page: PageKey) => void }) {
  // 与左侧导航共用同一份本地配置：用 useSyncExternalStore 读取，
  // 服务端快照回退默认值、客户端读 localStorage，避免水合不匹配。
  const shortcuts = useSyncExternalStore(
    subscribeShortcuts,
    () => parseShortcuts(readShortcutSnapshot()),
    () => DEFAULT_SHORTCUTS,
  );
  // 编辑态草稿：改动先落在 draft，点保存才写入，
  // 避免误触「上移/移除」直接把用户配置改掉。
  const [draft, setDraft] = useState<PageKey[] | null>(null);
  const editing = draft !== null;
  const list = draft ?? shortcuts;
  const available = shortcutCatalog.filter((item) => !list.includes(item.key));
  const full = list.length >= MAX_SHORTCUTS;

  // ---------- 实时状态 ----------
  //
  // 只做入口、不放任何状态会让首页显得空。
  // 这里取各业务面的真实计数，作为每个入口的副标题，
  // 同时汇总成顶部一条概览。取数失败时静默降级为空状态，
  // 不阻塞入口本身的跳转能力（入口是导航，不是数据看板）。
  const [stats, setStats] = useState<Partial<Record<PageKey, string>>>({});
  const [summary, setSummary] = useState<{ terminals: number; activeBroadcasts: number; pendingSchedules: number; media: number }>({ terminals: 0, activeBroadcasts: 0, pendingSchedules: 0, media: 0 });

  const refresh = useCallback(async () => {
    try {
      const [terminalPayload, broadcastPayload, schedulePayload, mediaPayload, playlistPayload, presetPayload, zonePayload, accountPayload] = await Promise.all([
        apiRequest<{ items: LiveTerminal[] }>("/registrations"),
        apiRequest<{ items: BackendBroadcast[] }>("/broadcasts"),
        apiRequest<{ items: BackendSchedule[] }>("/schedules"),
        apiRequest<{ items: MediaFile[] }>("/media/files"),
        apiRequest<{ count: number }>("/media/playlists"),
        apiRequest<{ items: unknown[] }>("/presets"),
        apiRequest<{ items: Array<{ id: string }> }>("/zones"),
        apiRequest<{ items: SipAccount[] }>("/sip-accounts"),
      ]);
      const terminalStates = new Set(["SUCCEEDED", "PARTIAL_FAILED", "FAILED", "CANCELED"]);
      const activeBroadcasts = broadcastPayload.items.filter((item) => !terminalStates.has(item.state)).length;
      const pendingSchedules = schedulePayload.items.filter((item) => item.enabled && item.nextRunAt).length;
      const online = terminalPayload.items.filter((item) => item.status !== "离线").length;

      setStats({
        realtime: activeBroadcasts > 0 ? `${activeBroadcasts} 个任务进行中` : `${broadcastPayload.items.length} 条历史记录`,
        presets: `${presetPayload.items.length} 个预设`,
        schedule: pendingSchedules > 0 ? `${pendingSchedules} 个待执行` : `${schedulePayload.items.length} 个计划`,
        tasks: `${broadcastPayload.items.length} 条任务记录`,
        content: `${mediaPayload.items.length} 个音频 · ${playlistPayload.count} 个列表`,
        terminals: `${online} / ${terminalPayload.items.length} 台在线`,
        resources: `${zonePayload.items.length} 个分区`,
        sipAccounts: `${accountPayload.items.length} 个账号`,
        overview: "服务状态与运行指标",
      });
      setSummary({
        terminals: online,
        activeBroadcasts,
        pendingSchedules,
        media: mediaPayload.items.length,
      });
    } catch {
      // 取数失败（例如未连接语音引擎）时保持空副标题，入口照常可用
      setStats({});
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    // 10 秒刷新：比 Overview 的 5 秒宽松，首页不需要秒级实时
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  // 所有编辑操作都基于「当前草稿，若未在编辑则基于已保存配置」，
  // 收敛成一个入口，避免每处都写一遍 `current ?? shortcuts`。
  const updateDraft = (transform: (current: PageKey[]) => PageKey[]) => {
    setDraft((current) => transform(current ?? shortcuts));
  };
  const save = () => {
    writeShortcuts(list);
    setDraft(null);
  };
  const add = (key: PageKey) => updateDraft((current) => {
    // 已达上限或已存在时保持不变（按钮本身也做了禁用，这里是第二道保险）
    if (current.includes(key) || current.length >= MAX_SHORTCUTS) return current;
    return [...current, key];
  });
  const remove = (key: PageKey) => updateDraft((current) => current.filter((item) => item !== key));
  const move = (index: number, delta: number) => updateDraft((current) => moveItem(current, index, index + delta));

  const hour = new Date().getHours();
  const greeting = hour < 6 ? "夜间好" : hour < 12 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";

  return <div className="page shortcut-page">
    <div className="page-heading split-heading">
      <div>
        <div className="eyebrow">{greeting}，今天是 {new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date())}</div>
        <h1>快捷入口</h1>
        <p>常用页面一键直达。点卡片进入，点右上角可调整常用项与顺序。</p>
      </div>
      <div className="heading-actions">
        {editing ? <>
          <button className="button button-secondary" onClick={() => setDraft(null)}>取消</button>
          <button className="button button-primary" onClick={save}>保存{list.length ? `（${list.length}）` : ""}</button>
        </> : <button className="button button-secondary" onClick={() => setDraft(shortcuts)}>✎ 自定义入口</button>}
      </div>
    </div>

    {/* 顶部概览：让首页有「今天状态如何」的信息量，而不是只有几个按钮 */}
    <section className="shortcut-summary" aria-label="运行概览">
      <button className="shortcut-summary-item" onClick={() => go("terminals")}>
        <span className="shortcut-summary-value">{summary.terminals}</span>
        <span className="shortcut-summary-label">台终端在线</span>
      </button>
      <button className="shortcut-summary-item" onClick={() => go("tasks")}>
        <span className="shortcut-summary-value">{summary.activeBroadcasts}</span>
        <span className="shortcut-summary-label">个广播进行中</span>
      </button>
      <button className="shortcut-summary-item" onClick={() => go("schedule")}>
        <span className="shortcut-summary-value">{summary.pendingSchedules}</span>
        <span className="shortcut-summary-label">个计划待执行</span>
      </button>
      <button className="shortcut-summary-item" onClick={() => go("content")}>
        <span className="shortcut-summary-value">{summary.media}</span>
        <span className="shortcut-summary-label">个音频素材</span>
      </button>
    </section>

    {editing && <div className="shortcut-editing-note">
      <span>i</span>
      <p>正在编辑：用 ↑ ↓ 调整顺序，× 移除；从下方「可添加的页面」点击加入。改动在点「保存」后才生效。</p>
    </div>}

    <section className="panel shortcut-panel">
      <div className="panel-title-row">
        <div>
          <span className="section-kicker">{editing ? "编辑中" : "全部入口"}</span>
          <h2>{list.length} 个快捷入口</h2>
        </div>
        {editing && <button className="text-button" onClick={() => setDraft(DEFAULT_SHORTCUTS)}>恢复默认</button>}
      </div>

      {list.length === 0 ? <div className="terminal-empty">
        <span>⚡</span>
        <h3>还没有快捷入口</h3>
        <p>{editing ? "从下方「可添加的页面」选择需要的页面。" : "点右上角「自定义入口」开始添加常用页面。"}</p>
        {!editing && <button className="button button-primary" onClick={() => setDraft([])}>开始添加</button>}
      </div> : <div className="shortcut-tiles">
        {list.map((key, index) => {
          const item = shortcutOf(key);
          const tone = index % SHORTCUT_TONES + 1;
          const subtitle = stats[key];
          // 非编辑态整卡即跳转；编辑态整卡只做排序/移除，避免误跳转
          return editing
            ? <div key={key} className={`shortcut-tile editing tone-${tone}`}>
              <span className="shortcut-order">{index + 1}</span>
              <span className="shortcut-tile-icon" aria-hidden="true">{item.icon}</span>
              <span className="shortcut-tile-body"><b>{item.label}</b><small>{subtitle ?? "—"}</small></span>
              <div className="shortcut-row-actions">
                <button aria-label={`上移 ${item.label}`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                <button aria-label={`下移 ${item.label}`} disabled={index === list.length - 1} onClick={() => move(index, 1)}>↓</button>
                <button className="remove" aria-label={`移除 ${item.label}`} onClick={() => remove(key)}>×</button>
              </div>
            </div>
            : <button key={key} className={`shortcut-tile tone-${tone}`} onClick={() => go(key)} title={`进入${item.label}`}>
              <span className="shortcut-tile-icon" aria-hidden="true">{item.icon}</span>
              <span className="shortcut-tile-body">
                <b>{item.label}</b>
                <small>{subtitle ?? "点此进入"}</small>
              </span>
              <span className="shortcut-tile-go" aria-hidden="true">→</span>
            </button>;
        })}
      </div>}
    </section>

    {editing && <section className="panel shortcut-panel">
      <div className="panel-title-row">
        <div>
          <span className="section-kicker">可选页面</span>
          <h2>添加更多入口</h2>
        </div>
        <span className="shortcut-count-hint">{list.length} / {MAX_SHORTCUTS}{full ? " · 已达上限" : ""}</span>
      </div>
      {available.length === 0
        ? <div className="terminal-empty"><b>所有页面都已添加</b><p>移除部分入口后才能继续添加。</p></div>
        : <div className="shortcut-available">
          {available.map((item) => <button key={item.key} disabled={full} className={full ? "blocked" : ""} onClick={() => add(item.key)} title={full ? `最多 ${MAX_SHORTCUTS} 个` : `添加 ${item.label}`}>
            <span className="shortcut-icon" aria-hidden="true">{item.icon}</span>
            {item.label}
            <i>+</i>
          </button>)}
        </div>}
      {full && available.length > 0 && <p className="shortcut-limit-hint">已达到 {MAX_SHORTCUTS} 个上限。若要添加其他页面，请先移除一个已有入口。</p>}
    </section>}

    {!editing && <p className="shortcut-page-note">快捷入口保存在当前浏览器，不会随账号同步；换设备后需重新设置。</p>}
  </div>;
}

function MediaLibrary({ notify }: { notify: (message: string) => void }) {
  const [tab, setTab] = useState<"files" | "playlists">("playlists");
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [playlists, setPlaylists] = useState<MediaPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  // 批量上传进度：done 为已完成个数，total 为本批待传个数
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState<MediaFile | null>(null);
  const [newPlaylist, setNewPlaylist] = useState<{ name: string } | null>(null);
  const [renamingPlaylist, setRenamingPlaylist] = useState<{ id: string; name: string } | null>(null);
  const [addingToPlaylist, setAddingToPlaylist] = useState<MediaPlaylist | null>(null);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [filePayload, playlistPayload] = await Promise.all([
        apiRequest<{ items: MediaFile[] }>("/media/files"),
        apiRequest<{ items: MediaPlaylist[] }>("/media/playlists"),
      ]);
      setFiles(filePayload.items);
      setPlaylists(playlistPayload.items);
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "媒体库加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  /**
   * 批量上传音频。
   * 后端接口是单文件上传，因此这里逐个发送：串行而非并发，
   * 避免一次选几十个文件时同时打满请求与磁盘写入。
   * 单个文件失败不影响其余文件继续上传，最后汇总提示。
   */
  const upload = async (fileList?: FileList | null) => {
    const selected = Array.from(fileList ?? []);
    if (!selected.length) return;

    const accepted = selected.filter((file) => /\.(wav|mp3)$/i.test(file.name));
    const rejected = selected.filter((file) => !/\.(wav|mp3)$/i.test(file.name));

    if (!accepted.length) {
      setError("仅支持 WAV 和 MP3 音频文件");
      if (fileInput.current) fileInput.current.value = "";
      return;
    }

    setUploading(true);
    setUploadProgress({ done: 0, total: accepted.length });
    setError("");
    const failed: string[] = [];
    const uploaded: string[] = [];

    try {
      for (const [index, file] of accepted.entries()) {
        try {
          await apiRequest<{ file: MediaFile }>("/media/files", {
            method: "POST",
            headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
            body: file,
          });
          uploaded.push(file.name);
        } catch (requestError) {
          failed.push(`${file.name}（${requestError instanceof Error ? requestError.message : "上传失败"}）`);
        }
        setUploadProgress({ done: index + 1, total: accepted.length });
      }

      if (uploaded.length === 1) notify(`音频“${uploaded[0]}”已上传`);
      else if (uploaded.length > 1) notify(`已上传 ${uploaded.length} 个音频文件`);
      // 失败与不支持的格式都汇总到错误条，避免只提示成功而掩盖问题。
      const problems = [
        ...rejected.map((file) => `${file.name}（仅支持 WAV / MP3）`),
        ...failed,
      ];
      if (problems.length) setError(`${problems.length} 个文件未上传：${problems.join("；")}`);
      await refresh();
    } finally {
      setUploading(false);
      setUploadProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const createPlaylist = async () => {
    if (!newPlaylist?.name.trim()) return;
    try {
      await apiRequest("/media/playlists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newPlaylist) });
      notify(`播放列表“${newPlaylist.name.trim()}”已创建`);
      setNewPlaylist(null);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "播放列表创建失败");
    }
  };

  const renamePlaylist = async () => {
    if (!renamingPlaylist?.name.trim()) return;
    try {
      await apiRequest(`/media/playlists/${renamingPlaylist.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: renamingPlaylist.name }) });
      notify(`播放列表已重命名为“${renamingPlaylist.name.trim()}”`);
      setRenamingPlaylist(null);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "重命名失败");
    }
  };

  const openAddToPlaylist = (playlist: MediaPlaylist) => {
    setSelectedFileIds([]);
    setAddingToPlaylist(playlist);
  };

  const addSelectedToPlaylist = async () => {
    if (!addingToPlaylist || selectedFileIds.length === 0) return;
    try {
      await Promise.all(selectedFileIds.map((audioFileId) => apiRequest(`/media/playlists/${addingToPlaylist.id}/items`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audioFileId }),
      })));
      notify(`已向“${addingToPlaylist.name}”添加 ${selectedFileIds.length} 个音频文件`);
      setAddingToPlaylist(null);
      setSelectedFileIds([]);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "添加失败");
    }
  };

  const removeFromPlaylist = async (playlist: MediaPlaylist, file: MediaFile) => {
    try {
      await apiRequest(`/media/playlists/${playlist.id}/items/${file.id}`, { method: "DELETE" });
      notify(`已从“${playlist.name}”移除 ${file.originalName}`);
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "移除失败");
    }
  };

  const sizeLabel = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;

  return <div className="page media-page">
    <div className="page-heading split-heading">
      <div><div className="breadcrumb">广播中心 / 媒体库</div><h1>媒体库</h1><p>集中管理 WAV、MP3 音频文件与播放列表，可直接试听并复用于广播任务。</p></div>
      <div className="heading-actions"><button className="button button-secondary" onClick={() => setNewPlaylist({ name: "" })}>＋ 新建播放列表</button><button className="button button-primary" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading && uploadProgress ? `上传中 ${uploadProgress.done}/${uploadProgress.total}…` : uploading ? "上传中…" : "↑ 上传音频"}</button><input ref={fileInput} className="visually-hidden" type="file" accept=".wav,.mp3,audio/wav,audio/mpeg" multiple onChange={(event) => void upload(event.target.files)} /></div>
    </div>

    {error && <div className="media-error"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
    <section className="panel media-workspace">
      <div className="media-tabs"><button className={tab === "playlists" ? "active" : ""} onClick={() => setTab("playlists")}>播放列表 <em>{playlists.length}</em></button><button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>音频文件 <em>{files.length}</em></button></div>

      {loading ? <div className="media-empty">正在加载媒体库…</div> : tab === "files" ? <>
        {files.length === 0 ? <div className="media-empty"><span>♪</span><b>还没有音频文件</b><p>上传 WAV 或 MP3 文件后即可试听并添加到播放列表。</p><button className="button button-primary" onClick={() => fileInput.current?.click()}>上传第一个音频</button></div> : <div className="media-file-list">
          {files.map((file) => <article className={playing?.id === file.id ? "playing" : ""} key={file.id}>
            <button className="media-play-button" aria-label={`试听 ${file.originalName}`} onClick={() => setPlaying(playing?.id === file.id ? null : file)}>{playing?.id === file.id ? "■" : "▶"}</button>
            <span className={`media-format ${file.format.toLowerCase()}`}>{file.format}</span>
            <div className="media-file-name"><b>{file.name}</b><small>{file.originalName} · {sizeLabel(file.size)} · {new Date(file.createdAt).toLocaleString("zh-CN")}</small></div>
          </article>)}
        </div>}
      </> : <>
        {playlists.length === 0 ? <div className="media-empty"><span>≡</span><b>还没有播放列表</b><p>先创建播放列表，再向不同列表中添加所需音频。</p><button className="button button-primary" onClick={() => setNewPlaylist({ name: "" })}>新建播放列表</button></div> : <div className="playlist-grid">{playlists.map((playlist) => <article key={playlist.id}><div className="playlist-heading"><span>≡</span><div><b>{playlist.name}</b></div><div className="playlist-heading-actions"><em>{playlist.files.length} 首</em><button className="playlist-rename" onClick={() => setRenamingPlaylist({ id: playlist.id, name: playlist.name })}>重命名</button><button className="button button-secondary small-button" onClick={() => openAddToPlaylist(playlist)}>＋ 添加音频</button></div></div><div className="playlist-items">{playlist.files.length === 0 ? <p>暂无音频，点击“添加音频”选择文件。</p> : playlist.files.map((file, index) => <div key={file.id}><span>{String(index + 1).padStart(2, "0")}</span><button onClick={() => setPlaying(file)}><b>{file.name}</b><small>{file.format} · {sizeLabel(file.size)}</small></button><button className="playlist-remove" aria-label={`从播放列表移除 ${file.originalName}`} onClick={() => void removeFromPlaylist(playlist, file)}>×</button></div>)}</div></article>)}</div>}
      </>}
    </section>

    {playing && <section className="media-player"><button className="media-player-close" onClick={() => setPlaying(null)}>×</button><span className={`media-format ${playing.format.toLowerCase()}`}>{playing.format}</span><div><b>正在试听：{playing.name}</b><small>{playing.originalName}</small></div><audio key={playing.id} controls autoPlay preload="metadata" src={`${broadcastApiBase}/media/files/${playing.id}/content?preview=${encodeURIComponent(playing.previewToken)}`}>当前浏览器不支持音频播放。</audio></section>}

    {newPlaylist && <div className="modal-backdrop" onMouseDown={() => setNewPlaylist(null)}><div className="modal media-playlist-modal" role="dialog" aria-modal="true" aria-labelledby="playlist-modal-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setNewPlaylist(null)}>×</button><div className="confirm-icon">≡</div><h2 id="playlist-modal-title">新建播放列表</h2><p>创建后可直接在该播放列表中添加 WAV 或 MP3 音频。</p><label className="modal-field"><span>播放列表名称 <em>*</em></span><input value={newPlaylist.name} autoFocus maxLength={80} onChange={(event) => setNewPlaylist({ name: event.target.value })} placeholder="例如：校园安全提醒" /></label><div className="modal-actions"><button className="button button-secondary" onClick={() => setNewPlaylist(null)}>取消</button><button className="button button-primary" disabled={!newPlaylist.name.trim()} onClick={() => void createPlaylist()}>创建</button></div></div></div>}

    {renamingPlaylist && <div className="modal-backdrop" onMouseDown={() => setRenamingPlaylist(null)}><div className="modal media-playlist-modal" role="dialog" aria-modal="true" aria-labelledby="rename-playlist-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setRenamingPlaylist(null)}>×</button><div className="confirm-icon">≡</div><h2 id="rename-playlist-title">重命名播放列表</h2><p>播放列表中的音频文件不会受到影响。</p><label className="modal-field"><span>播放列表名称 <em>*</em></span><input value={renamingPlaylist.name} autoFocus maxLength={80} onChange={(event) => setRenamingPlaylist({ ...renamingPlaylist, name: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") void renamePlaylist(); }} /></label><div className="modal-actions"><button className="button button-secondary" onClick={() => setRenamingPlaylist(null)}>取消</button><button className="button button-primary" disabled={!renamingPlaylist.name.trim()} onClick={() => void renamePlaylist()}>保存名称</button></div></div></div>}

    {addingToPlaylist && <div className="modal-backdrop" onMouseDown={() => setAddingToPlaylist(null)}><div className="modal media-add-modal" role="dialog" aria-modal="true" aria-labelledby="add-media-modal-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setAddingToPlaylist(null)}>×</button><div className="confirm-icon">♪</div><h2 id="add-media-modal-title">向“{addingToPlaylist.name}”添加音频</h2><p>选择一个或多个音频文件，仅会添加到当前播放列表。</p><div className="media-picker">{files.filter((file) => !addingToPlaylist.files.some((item) => item.id === file.id)).length === 0 ? <div className="media-picker-empty">没有可添加的音频，请先上传新文件。</div> : files.filter((file) => !addingToPlaylist.files.some((item) => item.id === file.id)).map((file) => <label key={file.id}><input type="checkbox" checked={selectedFileIds.includes(file.id)} onChange={(event) => setSelectedFileIds((current) => event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id))} /><span className={`media-format ${file.format.toLowerCase()}`}>{file.format}</span><span><b>{file.name}</b><small>{file.originalName} · {sizeLabel(file.size)}</small></span></label>)}</div><div className="modal-actions"><button className="button button-secondary" onClick={() => setAddingToPlaylist(null)}>取消</button><button className="button button-primary" disabled={selectedFileIds.length === 0} onClick={() => void addSelectedToPlaylist()}>添加所选音频{selectedFileIds.length > 0 ? `（${selectedFileIds.length}）` : ""}</button></div></div></div>}
  </div>;
}

function Permissions({ role, notify }: { role: Role; notify: (message: string) => void }) {
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [error, setError] = useState("");
  const [newUser, setNewUser] = useState<{ username: string; name: string; role: Role; password: string } | null>(null);
  const [editingUser, setEditingUser] = useState<(SystemUser & { password: string }) | null>(null);
  const [deleteUser, setDeleteUser] = useState<SystemUser | null>(null);
  const [editingRules, setEditingRules] = useState<PermissionRule[] | null>(null);
  const [saving, setSaving] = useState(false);
  const refresh = useCallback(async () => {
    try { const [userPayload, rulePayload] = await Promise.all([apiRequest<{ items: SystemUser[] }>("/users"), apiRequest<{ items: PermissionRule[] }>("/permissions")]); setUsers(userPayload.items); setRules(rulePayload.items); setError(""); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "用户权限读取失败"); }
  }, []);
  useEffect(() => { const initial = window.setTimeout(() => void refresh(), 0); const timer = window.setInterval(() => void refresh(), 5000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [refresh]);
  const createUser = async () => { if (!newUser) return; try { await apiRequest("/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newUser) }); notify(`用户“${newUser.name}”已创建`); setNewUser(null); await refresh(); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "用户创建失败"); } };
  const toggleUser = async (user: SystemUser) => { try { await apiRequest(`/users/${user.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !user.enabled }) }); notify(`用户“${user.name}”已${user.enabled ? "停用" : "启用"}`); await refresh(); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "用户状态更新失败"); } };
  const updateUser = async () => { if (!editingUser) return; setSaving(true); try { await apiRequest(`/users/${editingUser.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: editingUser.name, role: editingUser.role, ...(editingUser.password ? { password: editingUser.password } : {}) }) }); notify(`用户“${editingUser.name}”已更新`); setEditingUser(null); await refresh(); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "用户更新失败"); } finally { setSaving(false); } };
  const removeUser = async () => { if (!deleteUser) return; setSaving(true); try { await apiRequest(`/users/${deleteUser.id}`, { method: "DELETE" }); notify(`用户“${deleteUser.name}”已删除`); setDeleteUser(null); await refresh(); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "用户删除失败"); } finally { setSaving(false); } };
  const saveRules = async () => { if (!editingRules) return; setSaving(true); try { const payload = await apiRequest<{ items: PermissionRule[] }>("/permissions", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: editingRules }) }); setRules(payload.items); setEditingRules(null); notify("角色权限已更新"); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "权限更新失败"); } finally { setSaving(false); } };
  const permissionOptions = ["允许", "只读", "禁止", "全部数据", "已授权分区与本人任务"];
  return <div className="page"><div className="page-heading split-heading"><div><div className="breadcrumb">系统管理 / 用户与权限</div><h1>用户与权限</h1><p>管理系统用户、账号状态和角色权限。</p></div><button className="button button-primary" disabled={role !== "系统管理员"} onClick={() => setNewUser({ username: "", name: "", role: "广播操作员", password: "123456" })}>＋ 新增用户</button></div>
    {error && <div className="media-error"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
    <section className="panel user-list primary-user-list"><div className="panel-title-row"><div><span className="section-kicker">用户账号</span><h2>用户列表</h2><p>查看系统用户、角色及当前账号状态。</p></div><span>{users.length} 个用户 · {users.filter((user) => user.enabled).length} 个启用</span></div><div className="user-rows">{users.map((user) => <div key={user.id}><span className="avatar">{user.name.slice(0, 1)}</span><span><b>{user.name}</b><small>{user.username} · {user.role}<em>更新于 {new Date(user.updatedAt).toLocaleString("zh-CN", { hour12: false })}</em></small></span><Status tone={user.enabled ? "success" : "neutral"}>{user.enabled ? "已启用" : "已停用"}</Status><div className="user-row-actions"><button className="link-action" disabled={role !== "系统管理员"} onClick={() => setEditingUser({ ...user, password: "" })}>编辑</button><button className="link-action" disabled={role !== "系统管理员"} onClick={() => void toggleUser(user)}>{user.enabled ? "停用" : "启用"}</button><button className="danger-link" disabled={role !== "系统管理员"} onClick={() => setDeleteUser(user)}>删除</button></div></div>)}{users.length === 0 && <div className="user-list-empty"><span>♙</span><div><b>暂无系统用户</b><p>新增用户后，可为其分配系统管理员或广播操作员角色。</p></div><button className="button button-primary small-button" disabled={role !== "系统管理员"} onClick={() => setNewUser({ username: "", name: "", role: "广播操作员", password: "123456" })}>＋ 新增用户</button></div>}</div></section>
    <div className="role-summary-grid"><article className="role-card admin"><div className="role-card-top"><span className="avatar role-avatar">管</span><Status tone="info">系统角色</Status></div><h2>系统管理员</h2><p>负责平台配置、设备运维、用户权限与系统安全。</p><div><span>用户数量</span><b>{users.filter((user) => user.role === "系统管理员").length} 人</b></div></article><article className="role-card operator"><div className="role-card-top"><span className="avatar role-avatar">播</span><Status tone="success">系统角色</Status></div><h2>广播操作员</h2><p>负责实时广播、定时计划、媒体和任务处理。</p><div><span>用户数量</span><b>{users.filter((user) => user.role === "广播操作员").length} 人</b></div></article><article className="role-note"><span>i</span><div><b>账号管理</b><p>可为用户分配角色，并启用或停用账号。</p></div></article></div>
    <section className="panel permission-matrix"><div className="panel-title-row"><div><span className="section-kicker">权限配置</span><h2>角色权限矩阵</h2></div><div className="permission-actions">{editingRules ? <><button className="button button-secondary small-button" disabled={saving} onClick={() => setEditingRules(null)}>取消</button><button className="button button-primary small-button" disabled={saving} onClick={() => void saveRules()}>{saving ? "保存中…" : "保存权限"}</button></> : <><span>{rules.length} 条规则</span><button className="button button-secondary small-button" disabled={role !== "系统管理员" || !rules.length} onClick={() => setEditingRules(rules.map((rule) => ({ ...rule })))}>编辑权限</button></>}</div></div><table className="data-table"><thead><tr><th>能力</th><th><span className="role-head admin-head">管</span>系统管理员</th><th><span className="role-head operator-head">播</span>广播操作员</th></tr></thead><tbody>{(editingRules ?? rules).map((rule, index) => <tr key={rule.capability}><td><b>{rule.capability}</b></td><td>{editingRules ? <select value={rule.admin} onChange={(event) => setEditingRules(editingRules.map((item, itemIndex) => itemIndex === index ? { ...item, admin: event.target.value } : item))}>{permissionOptions.map((option) => <option key={option}>{option}</option>)}</select> : rule.admin}</td><td>{editingRules ? <select value={rule.operator} onChange={(event) => setEditingRules(editingRules.map((item, itemIndex) => itemIndex === index ? { ...item, operator: event.target.value } : item))}>{permissionOptions.map((option) => <option key={option}>{option}</option>)}</select> : rule.operator}</td></tr>)}</tbody></table></section>
    {newUser && <div className="modal-backdrop" onMouseDown={() => setNewUser(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-system-user-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setNewUser(null)}>×</button><div className="confirm-icon">♙</div><h2 id="new-system-user-title">新增系统用户</h2><div className="schedule-form"><label><span>登录名</span><input value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value.replace(/[^A-Za-z0-9_.-]/g, "") })} /></label><label><span>显示名称</span><input value={newUser.name} onChange={(event) => setNewUser({ ...newUser, name: event.target.value })} /></label><label><span>登录密码</span><input type="password" autoComplete="new-password" value={newUser.password} onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} /></label><label><span>角色</span><select value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value as Role })}><option>广播操作员</option><option>系统管理员</option></select></label></div><div className="modal-actions"><button className="button button-secondary" onClick={() => setNewUser(null)}>取消</button><button className="button button-primary" disabled={newUser.username.length < 3 || !newUser.name.trim() || newUser.password.length < 6} onClick={() => void createUser()}>创建用户</button></div></div></div>}
    {editingUser && <div className="modal-backdrop" onMouseDown={() => setEditingUser(null)}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-system-user-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setEditingUser(null)}>×</button><div className="confirm-icon">✎</div><h2 id="edit-system-user-title">编辑系统用户</h2><p className="modal-description">登录名 {editingUser.username}</p><div className="schedule-form"><label><span>显示名称</span><input value={editingUser.name} maxLength={60} onChange={(event) => setEditingUser({ ...editingUser, name: event.target.value })} /></label><label><span>新密码</span><input type="password" autoComplete="new-password" value={editingUser.password} onChange={(event) => setEditingUser({ ...editingUser, password: event.target.value })} placeholder="留空表示不修改" /></label><label><span>角色</span><select value={editingUser.role} onChange={(event) => setEditingUser({ ...editingUser, role: event.target.value as Role })}><option>广播操作员</option><option>系统管理员</option></select></label></div><div className="modal-actions"><button className="button button-secondary" disabled={saving} onClick={() => setEditingUser(null)}>取消</button><button className="button button-primary" disabled={saving || !editingUser.name.trim() || (editingUser.password.length > 0 && editingUser.password.length < 6)} onClick={() => void updateUser()}>{saving ? "保存中…" : "保存修改"}</button></div></div></div>}
    {deleteUser && <div className="modal-backdrop" onMouseDown={() => setDeleteUser(null)}><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-system-user-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setDeleteUser(null)}>×</button><div className="confirm-icon danger-confirm">!</div><h2 id="delete-system-user-title">删除用户“{deleteUser.name}”？</h2><p>该用户将无法继续使用系统，删除后不能恢复。</p><div className="modal-actions"><button className="button button-secondary" disabled={saving} onClick={() => setDeleteUser(null)}>取消</button><button className="button button-danger-solid" disabled={saving} onClick={() => void removeUser()}>{saving ? "正在删除…" : "确认删除"}</button></div></div></div>}
  </div>;
}

// 系统配置分区：内容较多，按主题切成标签页，避免单页过长难以查找。
// key 同时用于「该分区是否有未保存改动」的标记。
const CONFIG_TABS = [
  { key: "basic", label: "基础设置", icon: "⚙", hint: "组织信息与页面风格" },
  { key: "codec", label: "编码格式", icon: "♪", hint: "媒体编码与协商优先级" },
  { key: "runtime", label: "运行状态", icon: "◉", hint: "服务摘要与资源占用" },
  { key: "backup", label: "备份与还原", icon: "⛁", hint: "导出、导入与恢复出厂" },
] as const;

type ConfigTabKey = typeof CONFIG_TABS[number]["key"];

function SystemConfig({ organizationName, theme, role, onSave, onThemeChange, notify }: { organizationName: string; theme: Theme; role: Role; onSave: (name: string) => void; onThemeChange: (theme: Theme) => void; notify: (message: string) => void }) {
  const [draftName, setDraftName] = useState(organizationName);
  const [organizationCode, setOrganizationCode] = useState("SIP-BROADCAST");
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [draftTheme, setDraftTheme] = useState<Theme>(theme);
  const [saved, setSaved] = useState<SystemConfigData | null>(null);
  const [runtime, setRuntime] = useState({ freeSwitch: false, sipAccounts: 0, mediaFiles: 0, schedules: 0, onlineTerminals: 0, zones: 0, activeBroadcasts: 0, users: 0, updatedAt: "" });
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<ConfigTabKey>("basic");
  // 编码格式的未保存状态由子组件上报：它有自己的 prefs 草稿，
  // 只有子组件知道是否与已保存值不同。
  const [codecDirty, setCodecDirty] = useState(false);

  const refreshRuntime = useCallback(async () => {
    try {
      const [statusPayload, accountPayload, mediaPayload, schedulePayload, terminalPayload, zonePayload, broadcastPayload, userPayload] = await Promise.all([
        apiRequest<{ status: string }>("/freeswitch/status"), apiRequest<{ count: number }>("/sip-accounts"), apiRequest<{ count: number }>("/media/files"), apiRequest<{ count: number }>("/schedules"), apiRequest<{ count: number }>("/registrations"), apiRequest<{ count: number }>("/zones"), apiRequest<{ items: BackendBroadcast[] }>("/broadcasts"), apiRequest<{ count: number }>("/users"),
      ]);
      setRuntime({ freeSwitch: /^UP\b/m.test(statusPayload.status), sipAccounts: accountPayload.count, mediaFiles: mediaPayload.count, schedules: schedulePayload.count, onlineTerminals: terminalPayload.count, zones: zonePayload.count, activeBroadcasts: broadcastPayload.items.filter((item) => !["SUCCEEDED", "PARTIAL_FAILED", "FAILED", "CANCELED"].includes(item.state)).length, users: userPayload.count, updatedAt: new Date().toISOString() }); setError("");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "系统配置读取失败"); }
  }, []);
  const refresh = useCallback(async () => {
    try { const configPayload = await apiRequest<{ config: SystemConfigData }>("/system/config"); const config = configPayload.config; setSaved(config); setDraftName(config.organizationName); setOrganizationCode(config.organizationCode); setContact(config.contact); setPhone(config.phone); setDraftTheme(config.theme); onSave(config.organizationName); setDirty(false); await refreshRuntime(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "系统配置读取失败"); }
  }, [onSave, refreshRuntime]);
  useEffect(() => { const initial = window.setTimeout(() => void refresh(), 0); const timer = window.setInterval(() => void refreshRuntime(), 5000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [refresh, refreshRuntime]);
  const updateName = (value: string) => { setDraftName(value); setDirty(true); };
  const selectTheme = async (nextTheme: Theme) => {
    if (nextTheme === draftTheme || themeSaving) return;
    const previousTheme = draftTheme;
    setDraftTheme(nextTheme); onThemeChange(nextTheme); setThemeSaving(true); setError("");
    try {
      const payload = await apiRequest<{ config: SystemConfigData }>("/system/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: nextTheme }) });
      setSaved((current) => current ? { ...current, theme: payload.config.theme, updatedAt: payload.config.updatedAt } : payload.config);
      setDraftTheme(payload.config.theme); onThemeChange(payload.config.theme); notify(`已切换为${payload.config.theme === "dark" ? "暗色" : "亮色"}风格`);
    } catch (requestError) {
      setDraftTheme(previousTheme); onThemeChange(previousTheme); setError(requestError instanceof Error ? requestError.message : "页面风格保存失败");
    } finally { setThemeSaving(false); }
  };
  const save = async () => {
    const nextName = draftName.trim();
    if (!nextName) return;
    try { const payload = await apiRequest<{ config: SystemConfigData }>("/system/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationName: nextName, organizationCode, contact, phone, theme: draftTheme }) }); setSaved(payload.config); onSave(payload.config.organizationName); onThemeChange(payload.config.theme); setDraftName(payload.config.organizationName); setDraftTheme(payload.config.theme); setDirty(false); notify("系统配置已保存"); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "系统配置保存失败"); }
  };

  // 各分区是否有未保存改动：切换到别的标签时在标签上打点，
  // 避免用户改完编码切走后忘记保存。
  const tabDirty: Record<ConfigTabKey, boolean> = { basic: dirty, codec: codecDirty, runtime: false, backup: false };
  const dirtyTabs = CONFIG_TABS.filter((tab) => tabDirty[tab.key]);

  return <div className="page system-config-page">
    <div className="page-heading split-heading"><div><div className="breadcrumb">系统管理 / 系统配置</div><h1>系统配置</h1><p>维护组织信息及 SIP 广播系统的基础运行参数。</p></div>{dirtyTabs.length > 0 && <button className="unsaved-badge" onClick={() => setActiveTab(dirtyTabs[0].key)}>● {dirtyTabs.map((tab) => tab.label).join("、")} 有未保存的修改</button>}</div>
    {error && <div className="media-error"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}

    {/* 标签栏：内容较多，分区展示避免单页过长 */}
    <div className="config-tabs" role="tablist" aria-label="系统配置分区">
      {CONFIG_TABS.map((tab) => <button
        key={tab.key}
        role="tab"
        id={`config-tab-${tab.key}`}
        aria-selected={activeTab === tab.key}
        aria-controls={`config-panel-${tab.key}`}
        className={activeTab === tab.key ? "active" : ""}
        onClick={() => setActiveTab(tab.key)}
      >
        <span className="config-tab-icon" aria-hidden="true">{tab.icon}</span>
        <span className="config-tab-text"><b>{tab.label}</b><small>{tab.hint}</small></span>
        {tabDirty[tab.key] && <i className="config-tab-dot" aria-label="有未保存的修改" />}
      </button>)}
    </div>

    <div className="system-config-layout">
      <div className="config-content">
        {/* 所有面板始终保持挂载，只用 hidden 控制可见性。
            若改成条件渲染，切换标签会卸载 CodecSettings，
            其中未保存的编码顺序草稿就会丢失。 */}
        <div className="config-pane" id="config-panel-basic" role="tabpanel" aria-labelledby="config-tab-basic" hidden={activeTab !== "basic"}>
          <section className="panel theme-card"><div className="panel-title-row"><div><span className="section-kicker">界面设置</span><h2>页面风格</h2><p>选择后立即应用并自动保存。</p></div><span className="theme-current-badge">{themeSaving ? "保存中…" : draftTheme === "light" ? "亮色" : "暗色"}</span></div><div className="theme-options" role="radiogroup" aria-label="页面风格"><button type="button" role="radio" aria-checked={draftTheme === "light"} disabled={themeSaving} className={draftTheme === "light" ? "selected" : ""} onClick={() => void selectTheme("light")}><span className="theme-preview light-preview"><i /><i /><i /><i /></span><span><b>亮色风格</b><small>明亮清晰，适合日间环境</small></span><em>{draftTheme === "light" ? "✓" : ""}</em></button><button type="button" role="radio" aria-checked={draftTheme === "dark"} disabled={themeSaving} className={draftTheme === "dark" ? "selected" : ""} onClick={() => void selectTheme("dark")}><span className="theme-preview dark-preview"><i /><i /><i /><i /></span><span><b>暗色风格</b><small>降低亮度，适合夜间值守</small></span><em>{draftTheme === "dark" ? "✓" : ""}</em></button></div></section>
          <section className="panel organization-card"><div className="panel-title-row"><div><span className="section-kicker">基础设置</span><h2>组织信息</h2><p>组织信息将显示在顶部栏、广播目标和分区管理中。</p></div><span className="organization-preview-mark">{(draftName.trim() || "组织").slice(0, 2)}</span></div><div className="organization-form"><label className="wide"><span>组织名称 <em>*</em></span><input value={draftName} maxLength={60} onChange={(event) => updateName(event.target.value)} placeholder="请输入组织名称" /><small>{draftName.length}/60</small></label><label><span>组织编码</span><input value={organizationCode} onChange={(event) => { setOrganizationCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "")); setDirty(true); }} /></label><label><span>所属时区</span><select value="Asia/Shanghai" disabled><option>Asia/Shanghai（UTC+8）</option></select></label><label><span>管理部门</span><input value={contact} onChange={(event) => { setContact(event.target.value); setDirty(true); }} placeholder="可选" /></label><label><span>联系电话</span><input value={phone} onChange={(event) => { setPhone(event.target.value); setDirty(true); }} placeholder="可选" /></label></div><div className="organization-actions"><button className="button button-secondary" disabled={!dirty || !saved} onClick={() => { if (!saved) return; setDraftName(saved.organizationName); setOrganizationCode(saved.organizationCode); setContact(saved.contact); setPhone(saved.phone); setDraftTheme(saved.theme); onThemeChange(saved.theme); setDirty(false); }}>取消修改</button><button className="button button-primary" disabled={!dirty || !draftName.trim() || organizationCode.length < 2} onClick={() => void save()}>保存设置</button></div></section>
        </div>

        <div className="config-pane" id="config-panel-codec" role="tabpanel" aria-labelledby="config-tab-codec" hidden={activeTab !== "codec"}>
          <CodecSettings role={role} notify={notify} onDirtyChange={setCodecDirty} />
        </div>

        <div className="config-pane" id="config-panel-runtime" role="tabpanel" aria-labelledby="config-tab-runtime" hidden={activeTab !== "runtime"}>
          <section className="panel config-sync-card"><span className="config-sync-icon">{runtime.freeSwitch ? "✓" : "!"}</span><div><div className="runtime-summary-heading"><span><b>服务摘要</b><p>系统资源和运行状态每 5 秒自动更新。{runtime.updatedAt ? ` 最近同步：${new Date(runtime.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}</p></span><button className="button button-secondary small-button" onClick={() => void refreshRuntime()}>↻ 刷新状态</button></div><div className="sync-tags"><span>通信服务 {runtime.freeSwitch ? "正常" : "异常"}</span><span>{runtime.onlineTerminals} 台在线终端</span><span>{runtime.zones} 个分区</span><span>{runtime.activeBroadcasts} 个活动广播</span><span>{runtime.sipAccounts} 个 SIP 账号</span><span>{runtime.mediaFiles} 个媒体文件</span><span>{runtime.schedules} 个定时计划</span><span>{runtime.users} 个系统用户</span></div></div></section>
          <section className="panel runtime-detail-card">
            <div className="panel-title-row"><div><span className="section-kicker">运行指标</span><h2>资源明细</h2><p>只读信息，用于快速判断系统负载。</p></div></div>
            <div className="runtime-metric-grid">
              <div><span>通信服务</span><b className={runtime.freeSwitch ? "ok" : "bad"}>{runtime.freeSwitch ? "运行正常" : "连接异常"}</b></div>
              <div><span>在线终端</span><b>{runtime.onlineTerminals}</b></div>
              <div><span>活动广播</span><b>{runtime.activeBroadcasts}</b></div>
              <div><span>SIP 账号</span><b>{runtime.sipAccounts}</b></div>
              <div><span>分区数量</span><b>{runtime.zones}</b></div>
              <div><span>媒体文件</span><b>{runtime.mediaFiles}</b></div>
              <div><span>定时计划</span><b>{runtime.schedules}</b></div>
              <div><span>系统用户</span><b>{runtime.users}</b></div>
            </div>
          </section>
        </div>
        <div className="config-pane" id="config-panel-backup" role="tabpanel" aria-labelledby="config-tab-backup" hidden={activeTab !== "backup"}>
          <BackupSettings role={role} notify={notify} onRestored={() => void refresh()} />
        </div>
      </div>
    </div>
  </div>;
}

// 备份包大小的人类可读格式
function sizeText(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}

/**
 * 备份与还原。
 *
 * 三个操作都是破坏性的（导入会整体替换业务数据，重置会清空并重建账号），
 * 因此：
 *   - 仅系统管理员可操作，非管理员只看到说明；
 *   - 导入前要求用户确认「已了解会覆盖现有数据」；
 *   - 重置要求手工输入 RESET，而不是点一下确定就执行。
 */
function BackupSettings({ role, notify, onRestored }: { role: Role; notify: (message: string) => void; onRestored: () => void }) {
  const editable = role === "系统管理员";
  const [manifest, setManifest] = useState<{ counts: Record<string, number>; audioFiles: number; audioBytes: number; dataBytes: number; generatedAt: string } | null>(null);
  const [rollbacks, setRollbacks] = useState<Array<{ name: string; size: number; createdAt: string }>>([]);
  const [busy, setBusy] = useState<"download" | "restore" | "reset" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // 待导入的文件：先选好、展示摘要、确认后才真正提交
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const payload = await apiRequest<{ manifest: typeof manifest; rollbacks: typeof rollbacks }>("/system/backup/info");
      setManifest(payload.manifest);
      setRollbacks(payload.rollbacks);
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "备份信息读取失败");
    }
  }, []);

  useEffect(() => { const initial = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(initial); }, [refresh]);

  const download = async () => {
    setBusy("download"); setError(""); setNotice("");
    try {
      // 备份接口返回二进制，不能用 apiRequest（它按 JSON 解析）
      const response = await fetch(`${broadcastApiBase}/system/backup`, { credentials: "include" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message ?? payload.error ?? `导出失败（${response.status}）`);
      }
      const blob = await response.blob();
      // 优先用服务端给出的文件名，回退到自己拼一个
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `sip-broadcast-backup-${Date.now()}.zip`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = filename;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      // 立即 revoke 在部分浏览器会中断下载，延后释放
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice(`备份包已导出：${filename}（${sizeText(blob.size)}）`);
      notify("备份包已导出");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "导出失败");
    } finally { setBusy(null); }
  };

  const pickFile = (file?: File) => {
    setError(""); setNotice("");
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { setError("请选择本系统导出的 .zip 备份包"); return; }
    setPendingFile(file);
  };

  const confirmRestore = async () => {
    if (!pendingFile) return;
    setBusy("restore"); setError(""); setNotice("");
    try {
      const payload = await apiRequest<{ imported: { dataFiles: string[]; audioFiles: number; ignoredDataFiles: string[] }; rollback: string | null }>("/system/restore", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: pendingFile,
      });
      setPendingFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setNotice(`导入完成：${payload.imported.dataFiles.length} 个数据文件、${payload.imported.audioFiles} 个音频${payload.rollback ? `；导入前状态已存为 ${payload.rollback}` : ""}`);
      notify("备份已导入");
      await refresh();
      onRestored();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "导入失败");
    } finally { setBusy(null); }
  };

  const doReset = async () => {
    setBusy("reset"); setError(""); setNotice("");
    try {
      const payload = await apiRequest<{ removedAudio: number; adminUsername: string; rollback: string | null; requiresRelogin: boolean }>("/system/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESET" }),
      });
      setResetOpen(false); setResetText("");
      // 用户表已重建，当前会话随之失效，必须重新登录
      if (payload.requiresRelogin) {
        notify(`已恢复出厂设置，请使用 ${payload.adminUsername} 重新登录`);
        window.setTimeout(() => window.location.reload(), 1200);
        return;
      }
      notify("已恢复出厂设置");
      await refresh();
      onRestored();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "重置失败");
    } finally { setBusy(null); }
  };

  const downloadRollback = async (name: string) => {
    setError("");
    try {
      const response = await fetch(`${broadcastApiBase}/system/rollback/${encodeURIComponent(name)}`, { credentials: "include" });
      if (!response.ok) throw new Error(`下载失败（${response.status}）`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = name;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "下载失败");
    }
  };

  const counts = manifest?.counts ?? {};
  const totalItems = (counts.zones ?? 0) + (counts.schedules ?? 0) + (counts.presets ?? 0) + (counts.mediaFiles ?? 0) + (counts.broadcasts ?? 0);

  return <>
    {!editable && <div className="backup-readonly">
      <span>i</span>
      <p>备份、导入与恢复出厂设置会整体替换系统数据，仅<b>系统管理员</b>可操作。当前角色为{role}，你可以查看备份概况。</p>
    </div>}

    {error && <div className="media-error"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
    {notice && <div className="backup-notice"><span>✓</span><p>{notice}</p><button onClick={() => setNotice("")}>×</button></div>}

    <section className="panel backup-card">
      <div className="panel-title-row">
        <div><span className="section-kicker">系统备份</span><h2>导出当前配置</h2><p>包含组织信息、用户与权限、分区、定时计划、预设广播、媒体库以及全部音频文件。</p></div>
        <button className="button button-secondary small-button" onClick={() => void refresh()}>↻ 刷新</button>
      </div>
      <div className="backup-stats">
        <div><span>分区</span><b>{counts.zones ?? 0}</b></div>
        <div><span>定时计划</span><b>{counts.schedules ?? 0}</b></div>
        <div><span>预设广播</span><b>{counts.presets ?? 0}</b></div>
        <div><span>媒体文件</span><b>{counts.mediaFiles ?? 0}</b></div>
        <div><span>音频体积</span><b>{sizeText(manifest?.audioBytes ?? 0)}</b></div>
        <div><span>用户</span><b>{counts.users ?? 0}</b></div>
      </div>
      <div className="backup-actions">
        <button className="button button-primary" disabled={!editable || busy !== null} onClick={() => void download()}>{busy === "download" ? "正在打包…" : "↓ 导出备份包"}</button>
        <small>导出为 ZIP，约 {sizeText((manifest?.audioBytes ?? 0) + (manifest?.dataBytes ?? 0))}。请妥善保管，包内含账号凭据哈希。</small>
      </div>
    </section>

    <section className="panel backup-card">
      <div className="panel-title-row">
        <div><span className="section-kicker">系统还原</span><h2>导入备份包</h2><p>导入会<b>整体覆盖</b>当前数据。系统会在导入前自动保存一份回滚包。</p></div>
      </div>

      {pendingFile ? <div className="backup-confirm">
        <div className="backup-confirm-head"><span>⚠</span><div><b>确认导入「{pendingFile.name}」？</b><p>当前 {totalItems} 项业务数据与 {manifest?.audioFiles ?? 0} 个音频文件将被备份包中的内容替换，此操作不可撤销（可通过回滚包找回）。</p></div></div>
        <div className="backup-confirm-actions">
          <button className="button button-secondary" disabled={busy !== null} onClick={() => { setPendingFile(null); if (fileInput.current) fileInput.current.value = ""; }}>取消</button>
          <button className="button button-danger-solid" disabled={busy !== null} onClick={() => void confirmRestore()}>{busy === "restore" ? "正在导入…" : "确认覆盖并导入"}</button>
        </div>
      </div> : <div className="backup-actions">
        <button className="button button-secondary" disabled={!editable || busy !== null} onClick={() => fileInput.current?.click()}>↑ 选择备份包…</button>
        <input ref={fileInput} className="visually-hidden" type="file" accept=".zip,application/zip" onChange={(event) => pickFile(event.target.files?.[0])} />
        <small>仅接受本系统导出的 .zip 备份包；格式不符或版本过新会被拒绝，不会改动现有数据。</small>
      </div>}

      {rollbacks.length > 0 && <div className="backup-rollbacks">
        <span className="backup-rollbacks-label">最近回滚包（导入或重置前自动生成，仅保留 5 个）</span>
        {rollbacks.map((item) => <div className="backup-rollback-row" key={item.name}>
          <span className="backup-rollback-icon">⛁</span>
          <div><b>{item.name}</b><small>{new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })} · {sizeText(item.size)}</small></div>
          <button className="text-button" onClick={() => void downloadRollback(item.name)}>下载</button>
        </div>)}
      </div>}
    </section>

    <section className="panel backup-card backup-danger">
      <div className="panel-title-row">
        <div><span className="section-kicker">危险操作</span><h2>恢复出厂设置</h2><p>清空全部分区、计划、预设、媒体、广播记录与用户账号，仅保留默认管理员。</p></div>
      </div>
      <div className="backup-danger-body">
        <ul>
          <li>所有媒体文件将从磁盘删除</li>
          <li>用户账号被重建，当前登录会立即失效</li>
          <li>执行前会自动生成回滚包，可从上方列表下载</li>
        </ul>
        <button className="button button-danger-solid" disabled={!editable || busy !== null} onClick={() => { setResetText(""); setResetOpen(true); }}>恢复出厂设置</button>
      </div>
    </section>

    {resetOpen && <div className="modal-backdrop" onMouseDown={() => busy === null && setResetOpen(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" disabled={busy !== null} onClick={() => setResetOpen(false)}>×</button>
        <div className="confirm-icon danger-confirm">!</div>
        <h2 id="reset-title">确认恢复出厂设置？</h2>
        <p>此操作会删除全部业务数据与用户账号，且<b>当前登录会立即失效</b>。系统会在执行前自动保存回滚包。</p>
        <label className="modal-field">
          <span>请输入 <b>RESET</b> 以确认</span>
          {/* 要求手工输入确认串：避免误点按钮就清空系统 */}
          <input value={resetText} autoFocus placeholder="RESET" onChange={(event) => setResetText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && resetText === "RESET" && busy === null) void doReset(); }} />
        </label>
        <div className="modal-actions">
          <button className="button button-secondary" disabled={busy !== null} onClick={() => setResetOpen(false)}>取消</button>
          <button className="button button-danger-solid" disabled={resetText !== "RESET" || busy !== null} onClick={() => void doReset()}>{busy === "reset" ? "正在重置…" : "确认恢复出厂设置"}</button>
        </div>
      </div>
    </div>}
  </>;
}

/**
 * 编码格式（Codec）配置。
 *
 * 顺序即优先级：终端与 FreeSWITCH 共同的编码里，越靠前的越先协商。
 * 保存后会把顺序下发给 FreeSWITCH 并重启 SIP profile —— 这一步会清空并
 * 重新建立所有终端注册（通常几秒），所以界面上必须明确提示。
 */
function CodecSettings({ role, notify, onDirtyChange }: { role: Role; notify: (message: string) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const editable = role === "系统管理员";
  const [catalog, setCatalog] = useState<CodecInfo[]>([]);
  const [prefs, setPrefs] = useState<string[]>([]);
  const [savedPrefs, setSavedPrefs] = useState<string[]>([]);
  const [active, setActive] = useState<string[] | null>(null);
  const [restartProfile, setRestartProfile] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const payload = await apiRequest<{ items: CodecInfo[]; prefs: string[]; active: string[] | null }>("/system/codecs");
      setCatalog(payload.items); setPrefs(payload.prefs); setSavedPrefs(payload.prefs); setActive(payload.active); setError("");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "编码格式读取失败"); }
  }, []);
  useEffect(() => { const initial = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(initial); }, [refresh]);

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= prefs.length) return;
    const next = [...prefs];
    [next[index], next[target]] = [next[target], next[index]];
    setPrefs(next);
  };
  const toggle = (id: string) => {
    setPrefs((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };
  const dirty = prefs.join(",") !== savedPrefs.join(",");
  // 把未保存状态上报给父组件：编码配置在独立标签页里，
  // 用户切走后仍需在标签上看到「未保存」提示，否则容易遗忘导致改动丢失。
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  // 是否与 FreeSWITCH 实际生效顺序一致：两端都启用且位置相同才算已生效，
  // 否则标为「待下发」，避免顺序不同却显示成已生效。
  const isLive = (id: string) => active !== null && active.includes(id)
    && savedPrefs.includes(id) && savedPrefs.indexOf(id) === active.indexOf(id);

  const save = async () => {
    if (!prefs.length) { setError("至少需要保留一种编码格式"); return; }
    setSaving(true); setError("");
    try {
      const payload = await apiRequest<{ prefs: string[]; applied: { restarted: boolean } | null; applyError: string | null }>("/system/codecs", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefs, restartProfile }),
      });
      setSavedPrefs(payload.prefs); setPrefs(payload.prefs);
      if (payload.applyError) setError(`顺序已保存，但下发到服务失败：${payload.applyError}`);
      else notify(payload.applied?.restarted ? "编码格式已保存，SIP 服务已重载" : "编码格式已保存（未重启 SIP 服务，下次启动生效）");
      await refresh();
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "编码格式保存失败"); }
    finally { setSaving(false); }
  };

  return <section className="panel codec-card">
    <div className="panel-title-row"><div><span className="section-kicker">媒体与转码</span><h2>编码格式（Codec）</h2><p>勾选系统支持的编码并调整优先级，顺序越靠前越优先协商。</p></div><span className="theme-current-badge">{active === null ? "服务未连接" : `生效 ${active.length} 种`}</span></div>
    {error && <div className="media-error"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
    <div className="codec-fields">
      {catalog.map((item) => {
        const index = prefs.indexOf(item.id);
        const enabled = index >= 0;
        const isActive = isLive(item.id);
        return <div key={item.id} className={`codec-field ${enabled ? "enabled" : ""}`}>
          {/* 用 div 承载勾选框：label 只包裹 input 会被 a11y 规则判为缺少可见文本，
              文本放在相邻节点并用 aria-label 补足可访问名。 */}
          <div className="codec-check">
            <input type="checkbox" id={`codec-${item.id}`} checked={enabled} disabled={!editable || saving} onChange={() => toggle(item.id)} aria-label={`启用 ${item.name}`} />
            <label htmlFor={`codec-${item.id}`} className="codec-check-text"><b>{item.name}</b><small>{item.rate >= 1000 ? `${item.rate / 1000} kHz` : `${item.rate} Hz`} · {item.bitrate}</small></label>
          </div>
          <p className="codec-note">{item.note}</p>
          <div className="codec-field-foot">
            <span className="codec-order">{enabled ? `优先级 ${index + 1}` : "未启用"}</span>
            {enabled && active !== null && <span className={`codec-live ${isActive ? "on" : "off"}`}>{isActive ? "已生效" : "待下发"}</span>}
            <div className="codec-move">
              <button type="button" disabled={!editable || !enabled || index === 0 || saving} onClick={() => move(index, -1)} aria-label={`提高 ${item.name} 优先级`}>↑</button>
              <button type="button" disabled={!editable || !enabled || index === prefs.length - 1 || saving} onClick={() => move(index, 1)} aria-label={`降低 ${item.name} 优先级`}>↓</button>
            </div>
          </div>
        </div>;
      })}
    </div>
    <div className="codec-footer">
      <label className="codec-restart"><input type="checkbox" checked={restartProfile} disabled={!editable || saving} onChange={(event) => setRestartProfile(event.target.checked)} /><span>保存后立即重启 SIP 服务生效</span></label>
      <p className="codec-warning">重启会清空并重新建立所有终端注册（通常数秒）；不勾选则只写配置，下次启动才生效。</p>
      <div className="organization-actions">
        <button className="button button-secondary" disabled={!dirty || saving} onClick={() => setPrefs(savedPrefs)}>取消修改</button>
        <button className="button button-primary" disabled={!editable || !dirty || saving || !prefs.length} onClick={() => void save()}>{saving ? "保存中…" : "保存编码设置"}</button>
      </div>
      {!editable && <p className="codec-warning">当前角色为只读，只有系统管理员可以修改编码配置。</p>}
    </div>
    {/* 顺序即优先级：最终下发给 FreeSWITCH 的 global_codec_prefs / outbound_codec_prefs */}
    <p className="codec-preview">当前顺序：<code>{prefs.length ? prefs.join(",") : "（空）"}</code>{active !== null && <> · 实际生效：<code>{active.join(",")}</code></>}</p>
  </section>;
}

function PlaceholderPage({ page }: { page: PageKey }) {
  const content: Partial<Record<PageKey, { crumb: string; title: string; desc: string; stats: string[]; cards: Array<[string, string, string]> }>> = {
    schedule: { crumb: "广播中心 / 定时计划", title: "定时计划", desc: "创建一次性或周期广播，提前发现目标、时间和优先级冲突。", stats: ["18 今日计划", "6 待执行", "1 存在冲突"], cards: [["14:00", "消防演练提示", "行政办公区 · P1 高"], ["17:30", "闭馆提醒", "体育场馆 · P2 普通"], ["18:00", "晚间校园音乐", "学生宿舍区 · P2 普通"]] },
    content: { crumb: "广播中心 / 媒体库", title: "媒体库", desc: "管理音频、标签、版本与引用关系，保障广播媒体安全可用。", stats: ["126 音频文件", "4 转码中", "18 被计划引用"], cards: [["MP3", "校园安全提示音", "00:28 · 安全提示"], ["MP3", "午间校园音乐", "05:58 · 日常音乐"], ["WAV", "临时通知前奏", "00:06 · 提示音"]] },
    system: { crumb: "系统管理 / 系统配置", title: "系统配置", desc: "集中维护 SIP、媒体、时间、存储和第三方调用规则。", stats: ["SIP 服务正常", "媒体节点 3 / 3", "存储使用 42%"], cards: [["SIP", "基础配置", "域、端口、鉴权与路由策略"], ["媒体", "媒体与转码", "Codec、RTP、组播与节点配置"], ["时间", "时间与日历", "Asia/Shanghai · NTP 正常"]] },
  };
  const data = content[page] ?? content.schedule!;
  return <div className="page"><div className="page-heading split-heading"><div><div className="breadcrumb">{data.crumb}</div><h1>{data.title}</h1><p>{data.desc}</p></div><button className="button button-primary">＋ 新建</button></div><section className="placeholder-stats">{data.stats.map((item, index) => { const [value, ...rest] = item.split(" "); return <div key={item}><span className={`placeholder-icon p${index}`}>{index === 0 ? "◉" : index === 1 ? "⌘" : "△"}</span><b>{value}</b><small>{rest.join(" ")}</small></div>; })}</section><section className="panel placeholder-panel"><div className="panel-title-row"><div><span className="section-kicker">工作列表</span><h2>需要关注</h2></div><button className="text-button">查看全部</button></div><div className="placeholder-list">{data.cards.map((card, index) => <button key={card[1]}><span className={`list-mark m${index}`}>{card[0]}</span><span><b>{card[1]}</b><small>{card[2]}</small></span><em>查看详情 →</em></button>)}</div></section></div>;
}

export default function Home() {
  const [page, setPage] = useState<PageKey>("shortcuts");
  const [authUser, setAuthUser] = useState<SystemUser | null | undefined>(undefined);
  const [profileMenu, setProfileMenu] = useState(false);
  const [toast, setToast] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [organizationName, setOrganizationName] = useState("广播组织");
  const [theme, setTheme] = useState<Theme>(() => typeof window !== "undefined" && window.localStorage.getItem("sip-theme") === "dark" ? "dark" : "light");
  const themeLoaded = useRef(false);
  const [systemHealthy, setSystemHealthy] = useState(false);
  const [activeTaskCount, setActiveTaskCount] = useState(0);

  const refreshShell = useCallback(async () => {
    try {
      const [configPayload, statusPayload, taskPayload] = await Promise.all([apiRequest<{ config: SystemConfigData }>("/system/config"), apiRequest<{ status: string }>("/freeswitch/status"), apiRequest<{ items: BackendBroadcast[] }>("/broadcasts")]);
      setOrganizationName(configPayload.config.organizationName); if (!themeLoaded.current) { setTheme(configPayload.config.theme); themeLoaded.current = true; } setSystemHealthy(/^UP\b/m.test(statusPayload.status)); setActiveTaskCount(taskPayload.items.filter((task) => !["SUCCEEDED", "PARTIAL_FAILED", "FAILED", "CANCELED"].includes(task.state)).length);
    } catch { setSystemHealthy(false); }
  }, []);
  useEffect(() => { const initial = window.setTimeout(() => void apiRequest<{ user: SystemUser }>("/auth/me").then((payload) => setAuthUser(payload.user)).catch(() => setAuthUser(null)), 0); return () => window.clearTimeout(initial); }, []);
  useEffect(() => { if (!authUser) return; const initial = window.setTimeout(() => void refreshShell(), 0); const timer = window.setInterval(() => void refreshShell(), 5000); return () => { window.clearTimeout(initial); window.clearInterval(timer); }; }, [authUser, refreshShell]);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; window.localStorage.setItem("sip-theme", theme); }, [theme]);
  const role: Role = authUser?.role ?? "广播操作员";
  const saveOrganizationName = (name: string) => { setOrganizationName(name); void apiRequest("/system/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationName: name }) }).catch(() => undefined); };

  const pageLabel = navGroups.flatMap(g => g.items).find(item => item.key === page)?.label ?? "运行总览";
  const go = (next: PageKey) => { setPage(next); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 3600); };
  const logout = async () => { await apiRequest("/auth/logout", { method: "POST" }).catch(() => undefined); setProfileMenu(false); setAuthUser(null); setPage("shortcuts"); };

  if (authUser === undefined) return <main className="auth-loading"><span className="brand-mark"><i /><i /><i /></span><p>正在验证登录状态…</p></main>;
  if (!authUser) return <LoginScreen onLogin={(user) => { setAuthUser(user); setPage("shortcuts"); }} />;

  return (
    <main className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><i /><i /><i /></span><span><b>SIP广播系统</b><small>SIP BROADCAST</small></span></div>
        <nav aria-label="主导航">
          {navGroups.map((group) => <div className="nav-group" key={group.label}><div className="nav-group-label">{group.label}</div>{group.items.map((item) => <button key={item.key} className={page === item.key ? "active" : ""} onClick={() => go(item.key)} title={collapsed ? item.label : undefined}><Icon>{item.icon}</Icon><span>{item.label}</span>{item.key === "tasks" && activeTaskCount > 0 && <em>{activeTaskCount}</em>}</button>)}</div>)}
        </nav>
        <div className="system-health"><div><i /><span><b>{systemHealthy ? "通信服务正常" : "通信服务异常"}</b><small>{systemHealthy ? "运行状态已同步" : "请检查服务连接"}</small></span></div><button onClick={() => go("system")}>›</button></div>
        <div className="version-tag" title={`程序版本 ${appVersion || "开发模式"}`}><span>版本</span><b>{formatAppVersion(appVersion)}</b></div>
        <button className="collapse-button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}>{collapsed ? "›" : "‹"}</button>
      </aside>
      <section className="main-area">
        <header className="topbar">
          <div className="topbar-context"><b>{pageLabel}</b><span>{organizationName}</span></div>
          <div className="topbar-right"><div className="profile-wrap"><button className="profile" onClick={() => setProfileMenu(!profileMenu)} aria-expanded={profileMenu}><span className="avatar">{authUser.name.slice(0, 1)}</span><span><b>{authUser.name}</b><small>{authUser.role}</small></span><em>⌄</em></button>{profileMenu && <div className="role-menu profile-menu"><span>当前账号</span><div className="profile-menu-user"><i className="avatar mini">{authUser.name.slice(0, 1)}</i><span><b>{authUser.name}</b><small>{authUser.username} · {authUser.role}</small></span></div><button className="logout-button" onClick={() => void logout()}>退出登录</button></div>}</div></div>
        </header>

        {page === "overview" && <Overview go={go} />}
        {page === "shortcuts" && <Shortcuts go={go} />}
        {page === "realtime" && <Realtime organizationName={organizationName} onStarted={(broadcast) => { notify(`广播任务已创建，正在向 ${broadcast.targets.length} 台终端下发`); go("tasks"); }} />}
        {page === "schedule" && <Schedule notify={notify} />}
        {page === "presets" && <PresetBroadcasts request={apiRequest} notify={notify} />}
        {page === "terminals" && <Terminals notify={notify} />}
        {page === "resources" && <Resources role={role} organizationName={organizationName} onOrganizationSave={saveOrganizationName} notify={notify} />}
        {page === "tasks" && <Tasks />}
        {page === "content" && <MediaLibrary notify={notify} />}
        {page === "sipAccounts" && <SipAccounts notify={notify} />}
        {page === "permissions" && <Permissions role={role} notify={notify} />}
        {page === "system" && <SystemConfig organizationName={organizationName} theme={theme} role={role} onSave={setOrganizationName} onThemeChange={setTheme} notify={notify} />}
        {!(["overview", "shortcuts", "realtime", "presets", "schedule", "terminals", "resources", "tasks", "content", "sipAccounts", "permissions", "system"] as PageKey[]).includes(page) && <PlaceholderPage page={page} />}
      </section>

      {toast && <div className="toast"><span>✓</span><div><b>操作成功</b><p>{toast}</p></div><button onClick={() => setToast("")}>×</button></div>}
    </main>
  );
}
