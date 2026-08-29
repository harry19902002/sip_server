"use client";

import { useEffect, useMemo, useState } from "react";

type PageKey =
  | "overview"
  | "realtime"
  | "schedule"
  | "tasks"
  | "content"
  | "terminals"
  | "resources"
  | "sipAccounts"
  | "permissions"
  | "system";

type Role = "系统管理员" | "广播操作员";

type MediaItem = { id: string; name: string; duration: string; category: string };
type BroadcastTarget = { extension: string; status: "queued" | "accepted" | "failed" | "cancelled"; error: string | null };
type BroadcastTask = {
  id: string;
  name: string;
  type: "realtime";
  status: "dispatching" | "accepted" | "partial" | "failed" | "cancelled";
  media: MediaItem;
  createdAt: string;
  updatedAt: string;
  targets: BroadcastTarget[];
};

async function controlApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/control/${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? "控制服务请求失败");
  return payload;
}

const navGroups: Array<{ label: string; items: Array<{ key: PageKey; label: string; icon: string; badge?: string }> }> = [
  { label: "工作台", items: [{ key: "overview", label: "运行总览", icon: "⌂" }] },
  {
    label: "广播业务",
    items: [
      { key: "realtime", label: "实时广播", icon: "◉" },
      { key: "schedule", label: "定时计划", icon: "◷" },
      { key: "tasks", label: "任务中心", icon: "≡", badge: "3" },
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
      { key: "system", label: "系统配置", icon: "⚙" },
    ],
  },
];

const zones = [
  { name: "教学楼", device: 86, online: 84, status: "良好", tag: "常用" },
  { name: "行政办公区", device: 42, online: 42, status: "良好", tag: "" },
  { name: "学生宿舍区", device: 128, online: 125, status: "注意", tag: "重点" },
  { name: "室外公共区", device: 64, online: 61, status: "注意", tag: "" },
  { name: "体育场馆", device: 36, online: 36, status: "良好", tag: "" },
];

const terminalRows = [
  { id: "SPK-A1-001", name: "A1 一层走廊音箱", extension: "81001", zone: "教学楼", location: "A1 / 一层东侧", ip: "10.20.1.31", type: "IP 音箱", status: "在线空闲", last: "刚刚", capability: "广播 · 监听", priority: 1 },
  { id: "SPK-A1-002", name: "A1 二层走廊音箱", extension: "81002", zone: "教学楼", location: "A1 / 二层西侧", ip: "10.20.1.32", type: "IP 音箱", status: "播放中", last: "刚刚", capability: "广播 · 监听", priority: 0 },
  { id: "SPK-B2-014", name: "B2 教室组音箱", extension: "81014", zone: "教学楼", location: "B2 / 201—208", ip: "10.20.2.14", type: "IP 音箱", status: "在线空闲", last: "8 秒前", capability: "广播 · 分组", priority: 1 },
  { id: "SPK-OA-006", name: "行政楼六层音箱", extension: "82006", zone: "行政办公区", location: "行政楼 / 六层", ip: "10.20.4.6", type: "IP 音箱", status: "在线空闲", last: "16 秒前", capability: "广播 · 监听", priority: 1 },
  { id: "GW-OA-01", name: "行政楼模拟广播网关", extension: "82901", zone: "行政办公区", location: "行政楼 / 机房", ip: "10.20.4.9", type: "SIP 网关", status: "在线空闲", last: "12 秒前", capability: "广播 · 分区", priority: 1 },
  { id: "SPK-D1-032", name: "宿舍 D1 北侧音柱", extension: "83032", zone: "学生宿舍区", location: "D1 / 北侧入口", ip: "10.20.8.32", type: "IP 音柱", status: "在线空闲", last: "22 秒前", capability: "广播 · 监听", priority: 1 },
  { id: "SPK-D3-018", name: "宿舍 D3 东侧音柱", extension: "83018", zone: "学生宿舍区", location: "D3 / 东侧入口", ip: "10.20.8.18", type: "IP 音柱", status: "离线", last: "12 分钟前", capability: "广播 · 监听", priority: 3 },
  { id: "SPK-SQ-021", name: "中心广场东侧音柱", extension: "84021", zone: "室外公共区", location: "中心广场 / 东侧", ip: "10.20.15.21", type: "IP 音柱", status: "异常", last: "3 分钟前", capability: "广播 · 监听", priority: 2 },
  { id: "SPK-GATE-02", name: "南门入口音柱", extension: "84002", zone: "室外公共区", location: "校园南门", ip: "10.20.15.2", type: "IP 音柱", status: "在线空闲", last: "6 秒前", capability: "广播 · 监听", priority: 1 },
  { id: "GW-GYM-01", name: "体育馆广播网关", extension: "85001", zone: "体育场馆", location: "体育馆 / 弱电间", ip: "10.20.12.9", type: "SIP 网关", status: "在线空闲", last: "1 分钟前", capability: "广播 · 分区", priority: 1 },
  { id: "SPK-FIELD-08", name: "田径场西侧音柱", extension: "85008", zone: "体育场馆", location: "田径场 / 西看台", ip: "10.20.12.18", type: "IP 音柱", status: "播放中", last: "刚刚", capability: "广播 · 监听", priority: 0 },
  { id: "SPK-GYM-12", name: "体育馆看台音箱", extension: "85012", zone: "体育场馆", location: "体育馆 / 二层看台", ip: "10.20.12.22", type: "IP 音箱", status: "在线空闲", last: "19 秒前", capability: "广播 · 监听", priority: 1 },
];

type SipAccount = {
  id: number;
  account: string;
  name: string;
  displayNumber: string;
  department: string;
  enabled: boolean;
  inspection: boolean;
  international: boolean;
  registration: "在线" | "离线" | "未注册";
  createdAt: string;
  lastRegistered: string;
  transport: "UDP" | "TCP" | "TLS";
};

const initialSipAccounts: SipAccount[] = [
  { id: 90045, account: "81001", name: "A1 一层走廊音箱", displayNumber: "81001", department: "教学楼", enabled: true, inspection: false, international: false, registration: "在线", createdAt: "2026-04-14 18:12", lastRegistered: "刚刚", transport: "UDP" },
  { id: 90044, account: "81002", name: "A1 二层走廊音箱", displayNumber: "81002", department: "教学楼", enabled: true, inspection: false, international: false, registration: "在线", createdAt: "2026-04-14 18:12", lastRegistered: "8 秒前", transport: "UDP" },
  { id: 90043, account: "81014", name: "B2 教室组音箱", displayNumber: "81014", department: "教学楼", enabled: true, inspection: true, international: false, registration: "在线", createdAt: "2026-04-14 18:12", lastRegistered: "16 秒前", transport: "TCP" },
  { id: 90042, account: "82006", name: "行政楼六层音箱", displayNumber: "82006", department: "行政办公区", enabled: true, inspection: false, international: false, registration: "在线", createdAt: "2026-05-08 10:21", lastRegistered: "22 秒前", transport: "UDP" },
  { id: 90041, account: "82901", name: "行政楼广播网关", displayNumber: "82901", department: "行政办公区", enabled: true, inspection: true, international: false, registration: "在线", createdAt: "2026-05-08 10:23", lastRegistered: "12 秒前", transport: "TCP" },
  { id: 90040, account: "83018", name: "宿舍 D3 东侧音柱", displayNumber: "83018", department: "学生宿舍区", enabled: true, inspection: false, international: false, registration: "离线", createdAt: "2026-05-11 14:06", lastRegistered: "12 分钟前", transport: "UDP" },
  { id: 90039, account: "83032", name: "宿舍 D1 北侧音柱", displayNumber: "83032", department: "学生宿舍区", enabled: true, inspection: false, international: false, registration: "在线", createdAt: "2026-05-11 14:08", lastRegistered: "18 秒前", transport: "UDP" },
  { id: 90038, account: "84002", name: "南门入口音柱", displayNumber: "84002", department: "室外公共区", enabled: true, inspection: false, international: false, registration: "在线", createdAt: "2026-06-02 09:31", lastRegistered: "6 秒前", transport: "TLS" },
  { id: 90037, account: "84021", name: "中心广场东侧音柱", displayNumber: "84021", department: "室外公共区", enabled: true, inspection: true, international: false, registration: "离线", createdAt: "2026-06-02 09:34", lastRegistered: "3 分钟前", transport: "TLS" },
  { id: 90036, account: "85001", name: "体育馆广播网关", displayNumber: "85001", department: "体育场馆", enabled: true, inspection: true, international: false, registration: "在线", createdAt: "2026-06-16 16:40", lastRegistered: "1 分钟前", transport: "TCP" },
  { id: 90035, account: "85008", name: "田径场西侧音柱", displayNumber: "85008", department: "体育场馆", enabled: true, inspection: false, international: false, registration: "在线", createdAt: "2026-06-16 16:42", lastRegistered: "刚刚", transport: "UDP" },
  { id: 90034, account: "89999", name: "临时测试终端", displayNumber: "89999", department: "未分配", enabled: false, inspection: false, international: false, registration: "未注册", createdAt: "2026-08-09 11:20", lastRegistered: "从未", transport: "UDP" },
];

const taskRows = [
  { id: "JOB-260810-0082", name: "午间校园音乐", type: "定时广播", target: "室外公共区等 3 个分区", progress: "126 / 128", status: "播放中", time: "12:00:00" },
  { id: "JOB-260810-0081", name: "教学楼下课铃", type: "定时广播", target: "教学楼", progress: "84 / 86", status: "部分成功", time: "11:40:00" },
  { id: "JOB-260810-0080", name: "消防演练广播测试", type: "演练任务", target: "行政办公区", progress: "42 / 42", status: "成功", time: "10:10:21" },
  { id: "JOB-260810-0079", name: "临时失物招领通知", type: "实时广播", target: "学生宿舍区", progress: "125 / 128", status: "成功", time: "09:36:42" },
];

type SchedulePlan = {
  id: string;
  name: string;
  media: string;
  targets: string[];
  repeat: "单次" | "每天" | "工作日" | "每周";
  date: string;
  time: string;
  volume: number;
  enabled: boolean;
  nextRun: string;
  lastResult: string;
  createdBy: string;
};

const initialSchedulePlans: SchedulePlan[] = [
  { id: "PLAN-260810-018", name: "消防演练提示", media: "校园安全提示音.mp3", targets: ["行政办公区"], repeat: "单次", date: "2026-08-11", time: "14:00", volume: 75, enabled: true, nextRun: "08-11 14:00", lastResult: "尚未执行", createdBy: "林值班员" },
  { id: "PLAN-260731-012", name: "闭馆提醒", media: "临时通知前奏.wav", targets: ["体育场馆"], repeat: "每天", date: "2026-08-01", time: "17:30", volume: 70, enabled: true, nextRun: "今天 17:30", lastResult: "成功 · 36/36", createdBy: "周系统管理员" },
  { id: "PLAN-260720-009", name: "晚间校园音乐", media: "午间校园音乐.mp3", targets: ["学生宿舍区"], repeat: "工作日", date: "2026-07-21", time: "18:00", volume: 60, enabled: true, nextRun: "今天 18:00", lastResult: "成功 · 125/128", createdBy: "林值班员" },
  { id: "PLAN-260612-006", name: "上课预备铃", media: "上课预备铃.mp3", targets: ["教学楼"], repeat: "工作日", date: "2026-06-15", time: "08:00", volume: 80, enabled: false, nextRun: "已暂停", lastResult: "成功 · 84/86", createdBy: "周系统管理员" },
];

const permissionRows = [
  ["查看总览与任务", "全部数据", "授权分区及本人相关任务"],
  ["发起实时广播", "可配置", "是，受数据范围和高风险规则约束"],
  ["创建 / 启用计划", "可配置", "是，受数据范围和内容状态约束"],
  ["停止他人任务", "是", "默认否；可由系统管理员专项授权"],
  ["管理设备 / 分区", "新增、编辑、导入、诊断", "只读，可查看状态和任务结果"],
  ["用户与系统配置", "是", "否"],
];

function Icon({ children }: { children: string }) {
  return <span className="nav-icon" aria-hidden="true">{children}</span>;
}

function Status({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "success" | "warning" | "danger" | "info" | "neutral" }) {
  return <span className={`status status-${tone}`}><i />{children}</span>;
}

function TopActions() {
  return (
    <div className="top-actions">
      <button className="icon-button" aria-label="搜索">⌕</button>
      <button className="icon-button" aria-label="通知">♢</button>
    </div>
  );
}

function Overview({ go }: { go: (page: PageKey) => void }) {
  return (
    <div className="page overview-page">
      <div className="page-heading split-heading">
        <div>
          <div className="eyebrow">2026 年 8 月 10 日 · 星期一</div>
          <h1>早上好，林值班员</h1>
          <p>广播系统运行平稳，当前有 1 个任务正在播放，今日计划执行正常。</p>
        </div>
        <div className="heading-actions">
          <button className="button button-secondary" onClick={() => go("schedule")}>＋ 新建定时计划</button>
          <button className="button button-primary" onClick={() => go("realtime")}>◉ 发起实时广播</button>
        </div>
      </div>

      <section className="metric-grid" aria-label="核心指标">
        <article className="metric-card accent-blue">
          <div className="metric-top"><span className="metric-icon">⌘</span><span className="trend up">↑ 0.6%</span></div>
          <strong>348 <small>/ 356</small></strong>
          <h3>在线设备</h3>
          <p>在线率 97.8% · 3 台异常</p>
        </article>
        <article className="metric-card accent-green">
          <div className="metric-top"><span className="metric-icon">◉</span><span className="live-dot">LIVE</span></div>
          <strong>1</strong>
          <h3>正在广播</h3>
          <p>覆盖 128 台终端</p>
        </article>
        <article className="metric-card accent-violet">
          <div className="metric-top"><span className="metric-icon">◷</span><span className="trend">未来 12 小时</span></div>
          <strong>18</strong>
          <h3>今日计划</h3>
          <p>已完成 11 · 待执行 6</p>
        </article>
      </section>

      <div className="dashboard-grid">
        <section className="panel active-panel">
          <div className="panel-title-row">
            <div><span className="section-kicker">当前广播</span><h2>午间校园音乐</h2></div>
            <Status tone="success">播放中</Status>
          </div>
          <div className="audio-visual" aria-label="音频播放波形">
            {[18, 34, 25, 47, 62, 38, 70, 52, 31, 58, 76, 45, 66, 42, 23, 54, 70, 49, 31, 18].map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}
          </div>
          <div className="play-progress"><span style={{ width: "42%" }} /></div>
          <div className="play-time"><span>02:31</span><span>05:58</span></div>
          <div className="active-meta">
            <div><span>目标范围</span><b>室外公共区等 3 个分区</b></div>
            <div><span>终端结果</span><b>126 成功 · 2 未确认</b></div>
            <div><span>发起人</span><b>系统计划</b></div>
          </div>
          <div className="panel-footer">
            <button className="text-button" onClick={() => go("tasks")}>查看任务详情 →</button>
            <button className="button button-danger-ghost">■ 停止广播</button>
          </div>
        </section>

        <section className="panel plans-panel">
          <div className="panel-title-row"><div><span className="section-kicker">计划日历</span><h2>今日待执行</h2></div><button className="text-button" onClick={() => go("schedule")}>查看全部</button></div>
          <div className="timeline">
            <div className="timeline-item done"><time>08:00</time><i /><div><b>上课预备铃</b><span>教学楼 · 已完成</span></div></div>
            <div className="timeline-item done"><time>11:40</time><i /><div><b>教学楼下课铃</b><span>教学楼 · 部分成功</span></div></div>
            <div className="timeline-item active"><time>12:00</time><i /><div><b>午间校园音乐</b><span>3 个分区 · 播放中</span></div></div>
            <div className="timeline-item"><time>14:00</time><i /><div><b>消防演练提示</b><span>行政办公区 · 待执行</span></div></div>
            <div className="timeline-item"><time>17:30</time><i /><div><b>闭馆提醒</b><span>体育场馆 · 待执行</span></div></div>
          </div>
        </section>
      </div>

      <div className="lower-grid lower-grid-single">
        <section className="panel zone-panel">
          <div className="panel-title-row"><div><span className="section-kicker">资源概览</span><h2>分区运行情况</h2></div><button className="text-button" onClick={() => go("resources")}>管理分区与终端</button></div>
          <div className="zone-list">
            {zones.map((zone) => (
              <div className="zone-row" key={zone.name}>
                <div className="zone-symbol">{zone.name.slice(0, 1)}</div>
                <div className="zone-main"><b>{zone.name}</b><span>{zone.online} / {zone.device} 台在线</span></div>
                <div className="mini-progress"><i style={{ width: `${zone.online / zone.device * 100}%` }} /></div>
                <Status tone={zone.status === "良好" ? "success" : "warning"}>{zone.status}</Status>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Realtime({ onStarted, organizationName }: { onStarted: (task: BroadcastTask) => void; organizationName: string }) {
  const [targetMode, setTargetMode] = useState<"zones" | "terminals">("zones");
  const [selectedZones, setSelectedZones] = useState(["教学楼", "行政办公区"]);
  const [selectedTerminals, setSelectedTerminals] = useState<string[]>([]);
  const [source, setSource] = useState("audio");
  const [confirm, setConfirm] = useState(false);
  const [search, setSearch] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState("safety-tone");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    controlApi<{ items: MediaItem[] }>("media").then(({ items }) => setMedia(items)).catch((error) => setSubmitError(`媒体目录加载失败：${error.message}`));
  }, []);

  const toggleZone = (name: string) => setSelectedZones((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  const toggleTerminal = (id: string) => setSelectedTerminals((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const selectedTerminalRows = terminalRows.filter((terminal) => selectedTerminals.includes(terminal.id));
  const dispatchTargets = (targetMode === "zones" ? terminalRows.filter((terminal) => selectedZones.includes(terminal.zone)) : selectedTerminalRows).filter((terminal) => terminal.status !== "离线" && terminal.status !== "异常");
  const selectedDevices = targetMode === "zones" ? terminalRows.filter((terminal) => selectedZones.includes(terminal.zone)).length : selectedTerminalRows.length;
  const onlineDevices = dispatchTargets.length;
  const selectedTargetCount = targetMode === "zones" ? selectedZones.length : selectedTerminals.length;
  const visibleTargetTerminals = terminalRows.filter((terminal) => [terminal.name, terminal.id, terminal.extension, terminal.zone].some((value) => value.toLowerCase().includes(search.trim().toLowerCase())));
  const targetLabel = targetMode === "zones" ? selectedZones.join("、") : selectedTerminalRows.map((terminal) => terminal.name).join("、");
  const selectAllTargets = () => targetMode === "zones" ? setSelectedZones(zones.filter((zone) => zone.name.includes(search)).map((zone) => zone.name)) : setSelectedTerminals(visibleTargetTerminals.map((terminal) => terminal.id));
  const selectedMedia = media.find((item) => item.id === selectedMediaId) ?? { id: "safety-tone", name: "校园安全提示音", duration: "4 秒", category: "安全提示" };
  const startBroadcast = async () => {
    setSubmitting(true);
    setSubmitError("");
    try {
      const { task } = await controlApi<{ task: BroadcastTask }>("broadcasts", {
        method: "POST",
        body: JSON.stringify({ name: `${selectedMedia.name} · 实时广播`, mediaId: selectedMedia.id, callerId: "9999", targets: dispatchTargets.map((terminal) => terminal.extension) }),
      });
      setConfirm(false);
      onStarted(task);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "广播任务创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page realtime-page">
      <div className="page-heading">
        <div className="breadcrumb">广播中心 / 实时广播</div>
        <h1>发起实时广播</h1>
        <p>选择目标与音频来源，预检通过后立即建立广播任务。</p>
      </div>

      <div className="steps" aria-label="广播配置步骤">
        <div className="step active"><span>1</span><div><b>选择目标</b><small>{targetMode === "zones" ? `${selectedZones.length} 个分区` : `${selectedTerminals.length} 台终端`}</small></div></div>
        <i />
        <div className="step active"><span>2</span><div><b>选择音源</b><small>{selectedMedia.name}</small></div></div>
        <i />
        <div className="step"><span>3</span><div><b>执行策略</b><small>音量与播放方式</small></div></div>
      </div>

      <div className="broadcast-builder">
        <section className="builder-card target-picker">
          <div className="builder-title"><div><span>01</span><h2>选择广播目标</h2></div><button className="text-button" onClick={selectAllTargets}>全选当前</button></div>
          <div className="target-mode-tabs"><button className={targetMode === "zones" ? "active" : ""} onClick={() => { setTargetMode("zones"); setSearch(""); }}>⌘ 按分区选择</button><button className={targetMode === "terminals" ? "active" : ""} onClick={() => { setTargetMode("terminals"); setSearch(""); }}>▤ 按终端选择</button></div>
          <label className="search-field"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={targetMode === "zones" ? "搜索分区" : "搜索终端名称、SIP ID 或分机号"} /></label>
          <div className="tree-root"><span className="tree-toggle">⌄</span><b>{organizationName}</b><small>356 台</small></div>
          {targetMode === "zones" && <div className="zone-check-list">
            {zones.filter(z => z.name.includes(search)).map((zone) => (
              <label className="zone-check" key={zone.name}>
                <input type="checkbox" checked={selectedZones.includes(zone.name)} onChange={() => toggleZone(zone.name)} />
                <span className="custom-check">✓</span>
                <span className="folder">▰</span>
                <span><b>{zone.name}</b><small>{zone.online} / {zone.device} 台在线</small></span>
                {zone.tag && <em>{zone.tag}</em>}
              </label>
            ))}
          </div>}
          {targetMode === "terminals" && <div className="zone-check-list terminal-target-list">
            {visibleTargetTerminals.map((terminal) => (
              <label className="zone-check terminal-target-check" key={terminal.id}>
                <input type="checkbox" checked={selectedTerminals.includes(terminal.id)} onChange={() => toggleTerminal(terminal.id)} />
                <span className="custom-check">✓</span>
                <span className={`target-terminal-icon ${terminal.type === "SIP 网关" ? "gateway" : ""}`}>{terminal.type === "SIP 网关" ? "GW" : "◖"}</span>
                <span><b>{terminal.name}</b><small>{terminal.extension} · {terminal.zone}</small></span>
                <em className={`target-status ${terminal.status === "在线空闲" || terminal.status === "播放中" ? "online" : "offline"}`}>{terminal.status}</em>
              </label>
            ))}
            {visibleTargetTerminals.length === 0 && <div className="target-list-empty">未找到匹配终端</div>}
          </div>}
          <div className="selection-summary"><div><strong>{selectedTargetCount}</strong><span>{targetMode === "zones" ? "已选分区" : "已选终端"}</span></div><div><strong>{selectedDevices}</strong><span>目标终端</span></div><div><strong className="success-number">{onlineDevices}</strong><span>当前可用</span></div></div>
        </section>

        <section className="builder-card source-picker">
          <div className="builder-title"><div><span>02</span><h2>选择音频来源</h2></div></div>
          <div className="segmented two-options">
            <button className={source === "audio" ? "active" : ""} onClick={() => setSource("audio")}>♪ 音频库</button>
            <button className={source === "template" ? "active" : ""} onClick={() => setSource("template")}>▦ 广播模板</button>
          </div>
          {source === "audio" && <>
            <label className="search-field"><span>⌕</span><input placeholder="搜索音频名称" /></label>
            <div className="audio-list">
              {(media.length ? media : [selectedMedia]).map((item) => <button key={item.id} className={selectedMediaId === item.id ? "audio-row selected" : "audio-row"} onClick={() => setSelectedMediaId(item.id)}><span className="play-circle">▶</span><span><b>{item.name}</b><small>{item.duration} · {item.category}</small></span>{selectedMediaId === item.id && <em>已选择</em>}</button>)}
            </div>
          </>}
          {source === "template" && <div className="template-list"><button className="template-card selected"><b>校园安全提醒</b><span>安全提示音 · 全文 28 秒</span></button><button className="template-card"><b>失物招领通知</b><span>前奏 + TTS 动态文本</span></button><button className="template-card"><b>临时闭馆通知</b><span>提示音 + 闭馆文案</span></button></div>}
        </section>

        <section className="builder-card strategy-card">
          <div className="builder-title"><div><span>03</span><h2>执行策略</h2></div></div>
          <div className="form-label"><span>播放音量</span><div className="range-line"><input type="range" min="0" max="100" defaultValue="75" /><b>75%</b></div></div>
          <label className="switch-line"><span><b>循环播放</b><small>内容结束后继续播放</small></span><input type="checkbox" /><i /></label>
          <button className="button button-primary full-button" disabled={!selectedTargetCount || !onlineDevices} onClick={() => { setSubmitError(""); setConfirm(true); }}>开始广播</button>
        </section>
      </div>

      {confirm && <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirm(false)}>
        <div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(e) => e.stopPropagation()}>
          <button className="modal-close" onClick={() => setConfirm(false)}>×</button>
          <div className="confirm-icon">◉</div>
          <h2 id="confirm-title">确认开始实时广播？</h2>
          <p>广播将立即下发至所选{targetMode === "zones" ? "分区" : "终端"}。开始后可在任务中心查看每台设备的执行结果。</p>
          <div className="confirm-facts"><div><span>广播内容</span><b>{selectedMedia.name}</b></div><div><span>目标范围</span><b>{targetLabel}</b></div><div><span>预计下发</span><b>{onlineDevices} 台可用终端</b></div><div><span>播放音量</span><b>75%</b></div></div>
          <div className="risk-note">广播会立即发送，请确认目标范围和音频内容无误。</div>
          {submitError && <div className="risk-note">{submitError}</div>}
          <div className="modal-actions"><button className="button button-secondary" disabled={submitting} onClick={() => setConfirm(false)}>取消</button><button className="button button-primary" disabled={submitting} onClick={startBroadcast}>{submitting ? "正在下发…" : "确认并开始"}</button></div>
        </div>
      </div>}
    </div>
  );
}

function Schedule({ notify }: { notify: (message: string) => void }) {
  const [plans, setPlans] = useState(initialSchedulePlans);
  const [tab, setTab] = useState<"全部" | "已启用" | "已暂停">("全部");
  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [activePlan, setActivePlan] = useState<SchedulePlan | null>(null);
  const [draft, setDraft] = useState<Pick<SchedulePlan, "name" | "media" | "targets" | "repeat" | "date" | "time" | "volume">>({
    name: "", media: "校园安全提示音.mp3", targets: ["教学楼"], repeat: "单次", date: "2026-08-12", time: "09:00", volume: 75,
  });

  const visiblePlans = useMemo(() => plans.filter((plan) => {
    const matchesTab = tab === "全部" || (tab === "已启用" ? plan.enabled : !plan.enabled);
    const keyword = search.trim().toLowerCase();
    return matchesTab && (!keyword || `${plan.name} ${plan.id} ${plan.media} ${plan.targets.join(" ")}`.toLowerCase().includes(keyword));
  }), [plans, search, tab]);

  const openEditor = () => {
    setDraft({ name: "", media: "校园安全提示音.mp3", targets: ["教学楼"], repeat: "单次", date: "2026-08-12", time: "09:00", volume: 75 });
    setEditorOpen(true);
  };
  const toggleTarget = (target: string) => setDraft((current) => ({ ...current, targets: current.targets.includes(target) ? current.targets.filter((item) => item !== target) : [...current.targets, target] }));
  const savePlan = () => {
    if (!draft.name.trim() || !draft.targets.length) return;
    const id = `PLAN-260811-${String(plans.length + 19).padStart(3, "0")}`;
    const plan: SchedulePlan = { ...draft, id, enabled: true, nextRun: `${draft.date.slice(5)} ${draft.time}`, lastResult: "尚未执行", createdBy: "林值班员" };
    setPlans((current) => [plan, ...current]);
    setEditorOpen(false);
    notify(`定时计划“${plan.name}”已创建`);
  };

  return (
    <div className="page schedule-page">
      <div className="page-heading split-heading"><div><div className="breadcrumb">广播中心 / 定时计划</div><h1>定时计划</h1><p>创建一次性或周期广播，统一管理执行时间、目标范围与媒体内容。</p></div><button className="button button-primary" onClick={openEditor}>＋ 新建计划</button></div>

      <section className="schedule-stats">
        <div><span className="schedule-stat-icon blue">◷</span><p><b>{plans.length}</b><small>全部计划</small></p></div>
        <div><span className="schedule-stat-icon green">✓</span><p><b>{plans.filter((plan) => plan.enabled).length}</b><small>已启用</small></p></div>
        <div><span className="schedule-stat-icon violet">▦</span><p><b>{plans.filter((plan) => plan.enabled && (plan.nextRun.includes("今天") || plan.nextRun.startsWith("08-11"))).length}</b><small>今日待执行</small></p></div>
        <div><span className="schedule-stat-icon orange">Ⅱ</span><p><b>{plans.filter((plan) => !plan.enabled).length}</b><small>已暂停</small></p></div>
      </section>

      <section className="panel schedule-panel">
        <div className="table-toolbar schedule-toolbar"><div className="tabs">{(["全部", "已启用", "已暂停"] as const).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}{item === "全部" ? ` ${plans.length}` : ""}</button>)}</div><div className="toolbar-actions"><label className="search-field compact"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索计划名称、编号或媒体" /></label><button className="button button-secondary small-button">筛选</button></div></div>
        <div className="table-scroll"><table className="data-table schedule-table"><thead><tr><th>计划名称 / 编号</th><th>执行周期</th><th>下次执行</th><th>目标范围</th><th>媒体内容</th><th>最近结果</th><th>状态</th><th>操作</th></tr></thead><tbody>{visiblePlans.map((plan) => <tr key={plan.id}><td><b>{plan.name}</b><small>{plan.id}</small></td><td><span className="repeat-tag">{plan.repeat}</span><small>{plan.repeat === "单次" ? plan.date : `${plan.repeat} ${plan.time}`}</small></td><td><b>{plan.nextRun}</b><small>音量 {plan.volume}%</small></td><td><b>{plan.targets.join("、")}</b><small>{plan.targets.reduce((sum, target) => sum + (zones.find((zone) => zone.name === target)?.device ?? 0), 0)} 台终端</small></td><td><b>{plan.media}</b><small>媒体库</small></td><td><Status tone={plan.lastResult.startsWith("成功") ? "success" : "neutral"}>{plan.lastResult}</Status></td><td><button className={`account-enable-switch ${plan.enabled ? "on" : ""}`} aria-label={`${plan.enabled ? "暂停" : "启用"}${plan.name}`} onClick={() => setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, enabled: !item.enabled, nextRun: item.enabled ? "已暂停" : `${item.date.slice(5)} ${item.time}` } : item))}><i /></button><small>{plan.enabled ? "已启用" : "已暂停"}</small></td><td><button className="link-action" onClick={() => setActivePlan(plan)}>查看详情</button></td></tr>)}</tbody></table></div>
        {visiblePlans.length === 0 && <div className="schedule-empty"><span>⌕</span><b>没有匹配的定时计划</b><button className="text-button" onClick={() => { setSearch(""); setTab("全部"); }}>清除筛选</button></div>}
        <div className="pagination"><span>共 {visiblePlans.length} 条计划</span><div><button disabled>‹</button><button className="active">1</button><button disabled>›</button></div></div>
      </section>

      {editorOpen && <div className="modal-backdrop" onMouseDown={() => setEditorOpen(false)}><div className="modal schedule-editor-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-editor-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setEditorOpen(false)}>×</button><div className="schedule-modal-heading"><span>◷</span><div><span className="section-kicker">定时广播</span><h2 id="schedule-editor-title">新建定时计划</h2><p>设置播放内容、执行时间和广播目标。</p></div></div><div className="schedule-form"><label className="wide"><span>计划名称 <em>*</em></span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：午间校园音乐" /></label><label><span>媒体内容 <em>*</em></span><select value={draft.media} onChange={(event) => setDraft({ ...draft, media: event.target.value })}><option>校园安全提示音.mp3</option><option>午间校园音乐.mp3</option><option>临时通知前奏.wav</option><option>上课预备铃.mp3</option></select></label><label><span>执行周期</span><select value={draft.repeat} onChange={(event) => setDraft({ ...draft, repeat: event.target.value as SchedulePlan["repeat"] })}><option>单次</option><option>每天</option><option>工作日</option><option>每周</option></select></label><label><span>{draft.repeat === "单次" ? "执行日期" : "开始日期"} <em>*</em></span><input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label><label><span>执行时间 <em>*</em></span><input type="time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label><label className="wide"><span>目标分区 <em>*</em></span><div className="schedule-targets">{zones.map((zone) => <button type="button" key={zone.name} className={draft.targets.includes(zone.name) ? "selected" : ""} onClick={() => toggleTarget(zone.name)}><i>{draft.targets.includes(zone.name) ? "✓" : "+"}</i><span><b>{zone.name}</b><small>{zone.online}/{zone.device} 台在线</small></span></button>)}</div></label><label className="wide schedule-volume"><span>播放音量 <b>{draft.volume}%</b></span><input type="range" min="10" max="100" value={draft.volume} onChange={(event) => setDraft({ ...draft, volume: Number(event.target.value) })} /></label></div><div className="schedule-form-note">计划创建后默认启用；可在计划列表中随时暂停或恢复。</div><div className="modal-actions"><button className="button button-secondary" onClick={() => setEditorOpen(false)}>取消</button><button className="button button-primary" disabled={!draft.name.trim() || !draft.targets.length || !draft.date || !draft.time} onClick={savePlan}>创建计划</button></div></div></div>}

      {activePlan && <div className="modal-backdrop" onMouseDown={() => setActivePlan(null)}><div className="modal schedule-detail-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-detail-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setActivePlan(null)}>×</button><div className="schedule-detail-heading"><span>◷</span><div><div><span className="section-kicker">{activePlan.id}</span><Status tone={activePlan.enabled ? "success" : "neutral"}>{activePlan.enabled ? "已启用" : "已暂停"}</Status></div><h2 id="schedule-detail-title">{activePlan.name}</h2><p>由 {activePlan.createdBy} 创建</p></div></div><div className="schedule-detail-grid"><div><span>媒体内容</span><b>{activePlan.media}</b></div><div><span>执行周期</span><b>{activePlan.repeat}</b></div><div><span>执行日期</span><b>{activePlan.date}</b></div><div><span>执行时间</span><b>{activePlan.time}</b></div><div><span>目标分区</span><b>{activePlan.targets.join("、")}</b></div><div><span>播放音量</span><b>{activePlan.volume}%</b></div><div><span>下次执行</span><b>{activePlan.nextRun}</b></div><div><span>最近结果</span><b>{activePlan.lastResult}</b></div></div><section className="schedule-history"><div className="panel-title-row"><div><span className="section-kicker">执行记录</span><h3>最近执行</h3></div></div>{activePlan.lastResult === "尚未执行" ? <p className="schedule-no-history">该计划尚无执行记录</p> : <div className="schedule-history-row"><span className="schedule-history-mark">✓</span><div><b>2026-08-10 {activePlan.time}</b><small>执行完成 · {activePlan.lastResult}</small></div><button className="text-button">任务详情</button></div>}</section><div className="modal-actions"><button className="button button-secondary" onClick={() => setActivePlan(null)}>关闭</button><button className="button button-primary" onClick={() => { setPlans((current) => current.map((item) => item.id === activePlan.id ? { ...item, enabled: !item.enabled, nextRun: item.enabled ? "已暂停" : `${item.date.slice(5)} ${item.time}` } : item)); setActivePlan(null); notify(`计划“${activePlan.name}”已${activePlan.enabled ? "暂停" : "启用"}`); }}>{activePlan.enabled ? "暂停计划" : "启用计划"}</button></div></div></div>}
    </div>
  );
}

function Terminals({ notify }: { notify: (message: string) => void }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("全部状态");
  const [selectedZone, setSelectedZone] = useState("全部终端");
  const [showOffline, setShowOffline] = useState(true);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState("状态优先");
  const [view, setView] = useState<"cards" | "table">("cards");
  const [activeTerminal, setActiveTerminal] = useState<(typeof terminalRows)[number] | null>(null);

  const visibleTerminals = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return terminalRows
      .filter((terminal) => selectedZone === "全部终端" || terminal.zone === selectedZone)
      .filter((terminal) => showOffline || terminal.status !== "离线")
      .filter((terminal) => statusFilter === "全部状态" || terminal.status === statusFilter)
      .filter((terminal) => !normalizedQuery || [terminal.name, terminal.id, terminal.extension, terminal.ip].some((value) => value.toLowerCase().includes(normalizedQuery)))
      .sort((a, b) => sortBy === "分机号" ? a.extension.localeCompare(b.extension) : sortBy === "终端名称" ? a.name.localeCompare(b.name, "zh-CN") : a.priority - b.priority);
  }, [query, selectedZone, showOffline, sortBy, statusFilter]);

  const selectedVisibleCount = visibleTerminals.filter((terminal) => selected.includes(terminal.id)).length;
  const onlineCount = terminalRows.filter((terminal) => terminal.status === "在线空闲" || terminal.status === "播放中").length;
  const toggleTerminal = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleMultiSelect = () => {
    setMultiSelect((current) => {
      if (current) setSelected([]);
      return !current;
    });
  };
  const runAction = (action: string, terminal: (typeof terminalRows)[number]) => {
    if (terminal.status === "离线" && action !== "查看详情") {
      notify(`${terminal.name} 当前离线，无法执行${action}`);
      return;
    }
    notify(`${action}指令已发送至 ${terminal.name}`);
  };

  return (
    <div className="page terminals-page">
      <div className="page-heading split-heading">
        <div><div className="breadcrumb">运营管理 / 终端列表</div><h1>终端列表</h1><p>按分区快速查找 SIP 终端，查看实时状态并执行单点或批量广播操作。</p></div>
        <div className="heading-actions"><button className="button button-secondary" onClick={() => notify("终端状态已刷新")}>↻ 刷新状态</button><button className="button button-primary" disabled={!selected.length} onClick={() => notify(`已为 ${selected.length} 台终端创建批量广播任务`)}>◉ 发起广播{selected.length ? `（${selected.length}）` : ""}</button></div>
      </div>

      <section className="terminal-summary" aria-label="终端状态概览">
        <div><span className="terminal-summary-icon all">▤</span><span><small>全部终端</small><b>{terminalRows.length}</b></span></div>
        <div><span className="terminal-summary-icon online">●</span><span><small>在线可用</small><b>{onlineCount}</b></span></div>
        <div><span className="terminal-summary-icon playing">◉</span><span><small>正在播放</small><b>{terminalRows.filter((terminal) => terminal.status === "播放中").length}</b></span></div>
        <div><span className="terminal-summary-icon issue">!</span><span><small>异常 / 离线</small><b>{terminalRows.filter((terminal) => terminal.status === "异常" || terminal.status === "离线").length}</b></span></div>
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
          <div className="tree-heading"><div><span className="section-kicker">组织</span><b>终端分区</b></div><em>{onlineCount}/{terminalRows.length} 在线</em></div>
          <button className={selectedZone === "全部终端" ? "terminal-zone active" : "terminal-zone"} onClick={() => setSelectedZone("全部终端")}><span>⌂</span><b>全部终端</b><em>{terminalRows.length}</em></button>
          {zones.map((zone) => {
            const zoneTerminals = terminalRows.filter((terminal) => terminal.zone === zone.name);
            return <button className={selectedZone === zone.name ? "terminal-zone active" : "terminal-zone"} key={zone.name} onClick={() => setSelectedZone(zone.name)}><span>⌘</span><b>{zone.name}</b><em>{zoneTerminals.filter((terminal) => terminal.status !== "离线" && terminal.status !== "异常").length}/{zoneTerminals.length}</em></button>;
          })}
          <div className="terminal-zone-note"><span>●</span><div><b>状态持续同步</b><small>最近更新：刚刚</small></div></div>
        </aside>

        <section className="terminal-results">
          <div className="terminal-results-head"><div><b>{selectedZone}</b><span>显示 {visibleTerminals.length} 台终端</span></div>{multiSelect && <div className="selection-actions"><span>已选 <b>{selected.length}</b> 台</span><button onClick={() => setSelected(Array.from(new Set([...selected, ...visibleTerminals.map((terminal) => terminal.id)])))}>全选当前</button><button onClick={() => setSelected((current) => visibleTerminals.filter((terminal) => !current.includes(terminal.id)).map((terminal) => terminal.id))}>反选</button><button onClick={() => setSelected([])}>清空</button></div>}</div>

          {visibleTerminals.length === 0 && <div className="terminal-empty"><span>⌕</span><h3>未找到匹配终端</h3><p>请调整搜索关键词、分区或状态筛选。</p><button className="text-button" onClick={() => { setQuery(""); setStatusFilter("全部状态"); setSelectedZone("全部终端"); setShowOffline(true); }}>清除筛选</button></div>}

          {view === "cards" && visibleTerminals.length > 0 && <div className="terminal-grid">{visibleTerminals.map((terminal) => {
            const isSelected = selected.includes(terminal.id);
            return <article className={`terminal-card ${isSelected ? "selected" : ""} ${terminal.status === "离线" ? "is-offline" : ""}`} key={terminal.id}>
              {multiSelect && <label className="terminal-check"><input type="checkbox" checked={isSelected} onChange={() => toggleTerminal(terminal.id)} aria-label={`选择 ${terminal.name}`} /><i>✓</i></label>}
              <div className="terminal-card-head"><span className={`terminal-device-icon ${terminal.type === "SIP 网关" ? "gateway" : ""}`}>{terminal.type === "SIP 网关" ? "GW" : "◖"}</span><div><b>{terminal.name}</b><small>{terminal.id}</small></div><Status tone={terminal.status === "在线空闲" || terminal.status === "播放中" ? "success" : terminal.status === "异常" ? "danger" : "neutral"}>{terminal.status}</Status></div>
              <div className="terminal-card-body"><div><span>所属分区</span><b>{terminal.zone} · {terminal.location}</b></div><div><span>SIP 分机号</span><b className="mono">{terminal.extension}</b></div><div><span>IP 地址</span><b className="mono">{terminal.ip}</b></div><div><span>终端能力</span><b>{terminal.capability}</b></div></div>
              <div className="terminal-card-foot"><span>最近通信：{terminal.last}</span><div><button onClick={() => runAction("单点广播", terminal)} disabled={terminal.status === "离线"}>◉<em>广播</em></button><button onClick={() => runAction("监听", terminal)} disabled={terminal.status === "离线"}>◒<em>监听</em></button><button onClick={() => setActiveTerminal(terminal)}>···<em>详情</em></button></div></div>
            </article>;
          })}</div>}

          {view === "table" && visibleTerminals.length > 0 && <section className="panel terminal-table-panel"><div className="table-scroll"><table className="data-table terminal-table"><thead><tr>{multiSelect && <th>选择</th>}<th>终端名称</th><th>分机号</th><th>所属分区</th><th>IP 地址</th><th>状态</th><th>最近通信</th><th>操作</th></tr></thead><tbody>{visibleTerminals.map((terminal) => <tr key={terminal.id}>{multiSelect && <td><input type="checkbox" checked={selected.includes(terminal.id)} onChange={() => toggleTerminal(terminal.id)} aria-label={`选择 ${terminal.name}`} /></td>}<td><b>{terminal.name}</b><small>{terminal.id} · {terminal.type}</small></td><td className="mono">{terminal.extension}</td><td>{terminal.zone}<small>{terminal.location}</small></td><td className="mono">{terminal.ip}</td><td><Status tone={terminal.status === "在线空闲" || terminal.status === "播放中" ? "success" : terminal.status === "异常" ? "danger" : "neutral"}>{terminal.status}</Status></td><td>{terminal.last}</td><td><button className="link-action" onClick={() => runAction("单点广播", terminal)} disabled={terminal.status === "离线"}>广播</button><button className="link-action" onClick={() => setActiveTerminal(terminal)}>详情</button></td></tr>)}</tbody></table></div></section>}

          {visibleTerminals.length > 0 && <div className="terminal-pagination"><span>第 1 页，共 {visibleTerminals.length} 条</span><div><button disabled>‹</button><button className="active">1</button><button disabled>›</button></div></div>}
        </section>
      </div>

      {activeTerminal && <div className="modal-backdrop" onMouseDown={() => setActiveTerminal(null)}><div className="modal terminal-detail-modal" role="dialog" aria-modal="true" aria-labelledby="terminal-detail-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setActiveTerminal(null)}>×</button><div className="terminal-detail-heading"><span className={`terminal-device-icon ${activeTerminal.type === "SIP 网关" ? "gateway" : ""}`}>{activeTerminal.type === "SIP 网关" ? "GW" : "◖"}</span><div><span className="section-kicker">终端详情</span><h2 id="terminal-detail-title">{activeTerminal.name}</h2><p>{activeTerminal.id} · {activeTerminal.type}</p></div></div><div className="terminal-detail-grid"><div><span>运行状态</span><Status tone={activeTerminal.status === "在线空闲" || activeTerminal.status === "播放中" ? "success" : activeTerminal.status === "异常" ? "danger" : "neutral"}>{activeTerminal.status}</Status></div><div><span>SIP 分机号</span><b>{activeTerminal.extension}</b></div><div><span>所属分区</span><b>{activeTerminal.zone}</b></div><div><span>安装位置</span><b>{activeTerminal.location}</b></div><div><span>IP 地址</span><b>{activeTerminal.ip}</b></div><div><span>终端能力</span><b>{activeTerminal.capability}</b></div><div><span>最近通信</span><b>{activeTerminal.last}</b></div><div><span>配置状态</span><b>已同步</b></div></div><div className="modal-actions"><button className="button button-secondary" onClick={() => { runAction("监听", activeTerminal); setActiveTerminal(null); }}>◒ 发起监听</button><button className="button button-primary" disabled={activeTerminal.status === "离线"} onClick={() => { runAction("单点广播", activeTerminal); setActiveTerminal(null); }}>◉ 单点广播</button></div></div></div>}
    </div>
  );
}

function SipAccounts({ notify }: { notify: (message: string) => void }) {
  const [accounts, setAccounts] = useState<SipAccount[]>(initialSipAccounts);
  const [nameQuery, setNameQuery] = useState("");
  const [accountQuery, setAccountQuery] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("全部部门");
  const [registrationFilter, setRegistrationFilter] = useState("全部状态");
  const [enabledFilter, setEnabledFilter] = useState("全部账号");
  const [selected, setSelected] = useState<number[]>([]);
  const [batchDepartment, setBatchDepartment] = useState("教学楼");
  const [editor, setEditor] = useState<{ mode: "new" | "edit"; data: SipAccount } | null>(null);
  const [password, setPassword] = useState("");
  const [deleteIds, setDeleteIds] = useState<number[]>([]);

  const filteredAccounts = useMemo(() => accounts.filter((account) => {
    const matchesName = !nameQuery.trim() || account.name.toLowerCase().includes(nameQuery.trim().toLowerCase());
    const matchesAccount = !accountQuery.trim() || [account.account, account.displayNumber].some((value) => value.includes(accountQuery.trim()));
    const matchesDepartment = departmentFilter === "全部部门" || account.department === departmentFilter;
    const matchesRegistration = registrationFilter === "全部状态" || account.registration === registrationFilter;
    const matchesEnabled = enabledFilter === "全部账号" || (enabledFilter === "已启用" ? account.enabled : !account.enabled);
    return matchesName && matchesAccount && matchesDepartment && matchesRegistration && matchesEnabled;
  }), [accountQuery, accounts, departmentFilter, enabledFilter, nameQuery, registrationFilter]);

  const resetFilters = () => {
    setNameQuery("");
    setAccountQuery("");
    setDepartmentFilter("全部部门");
    setRegistrationFilter("全部状态");
    setEnabledFilter("全部账号");
  };
  const newAccount = (): SipAccount => ({ id: Date.now(), account: "", name: "", displayNumber: "", department: "未分配", enabled: true, inspection: false, international: false, registration: "未注册", createdAt: "2026-08-11 17:30", lastRegistered: "从未", transport: "UDP" });
  const openNew = () => { setPassword(""); setEditor({ mode: "new", data: newAccount() }); };
  const openEdit = (account: SipAccount) => { setPassword(""); setEditor({ mode: "edit", data: { ...account } }); };
  const saveAccount = () => {
    if (!editor) return;
    const data = { ...editor.data, displayNumber: editor.data.displayNumber || editor.data.account };
    if (!data.account.trim() || !data.name.trim()) {
      notify("请填写 SIP 账号和账号名称");
      return;
    }
    if (accounts.some((account) => account.account === data.account && account.id !== data.id)) {
      notify(`SIP 账号 ${data.account} 已存在`);
      return;
    }
    setAccounts((current) => editor.mode === "new" ? [data, ...current] : current.map((account) => account.id === data.id ? data : account));
    setEditor(null);
    notify(editor.mode === "new" ? `SIP 账号 ${data.account} 已创建` : `SIP 账号 ${data.account} 已更新`);
  };
  const toggleSelected = (id: number) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const selectCurrentPage = () => setSelected((current) => Array.from(new Set([...current, ...filteredAccounts.map((account) => account.id)])));
  const assignDepartment = () => {
    setAccounts((current) => current.map((account) => selected.includes(account.id) ? { ...account, department: batchDepartment } : account));
    notify(`已将 ${selected.length} 个账号归属至${batchDepartment}`);
    setSelected([]);
  };
  const confirmDelete = () => {
    setAccounts((current) => current.filter((account) => !deleteIds.includes(account.id)));
    setSelected((current) => current.filter((id) => !deleteIds.includes(id)));
    notify(`已删除 ${deleteIds.length} 个 SIP 账号`);
    setDeleteIds([]);
  };
  const onlineAccounts = accounts.filter((account) => account.registration === "在线").length;
  const enabledAccounts = accounts.filter((account) => account.enabled).length;

  return (
    <div className="page sip-accounts-page">
      <div className="page-heading split-heading"><div><div className="breadcrumb">系统 / SIP 账号管理</div><h1>SIP 账号管理</h1><p>集中维护 SIP 分机账号、鉴权、部门归属和注册状态，支持批量配置与安全审计。</p></div><div className="heading-actions"><button className="button button-secondary" onClick={() => notify("SIP 注册状态已刷新")}>↻ 刷新</button><button className="button button-primary" onClick={openNew}>＋ 新增账号</button></div></div>

      <section className="sip-account-stats" aria-label="SIP 账号概览">
        <div><span>账号总数</span><b>{accounts.length}</b><small>覆盖 5 个业务部门</small></div>
        <div><span>已启用</span><b className="green">{enabledAccounts}</b><small>配置启用率 {Math.round(enabledAccounts / Math.max(accounts.length, 1) * 100)}%</small></div>
        <div><span>在线注册</span><b className="green">{onlineAccounts}</b><small>注册率 {Math.round(onlineAccounts / Math.max(enabledAccounts, 1) * 100)}%</small></div>
        <div><span>离线 / 未注册</span><b className="orange">{accounts.length - onlineAccounts}</b><small>建议检查网络与鉴权</small></div>
      </section>

      <section className="panel sip-filter-panel">
        <div className="sip-filter-grid">
          <label><span>账号名称</span><input value={nameQuery} onChange={(event) => setNameQuery(event.target.value)} placeholder="请输入账号名称" /></label>
          <label><span>SIP 账号</span><input value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} placeholder="账号或显示号码" /></label>
          <label><span>部门</span><select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}><option>全部部门</option>{zones.map((zone) => <option key={zone.name}>{zone.name}</option>)}<option>未分配</option></select></label>
          <label><span>注册状态</span><select value={registrationFilter} onChange={(event) => setRegistrationFilter(event.target.value)}><option>全部状态</option><option>在线</option><option>离线</option><option>未注册</option></select></label>
          <label><span>启用状态</span><select value={enabledFilter} onChange={(event) => setEnabledFilter(event.target.value)}><option>全部账号</option><option>已启用</option><option>已停用</option></select></label>
          <div className="sip-filter-actions"><button className="button button-primary" onClick={() => notify(`已筛选出 ${filteredAccounts.length} 个 SIP 账号`)}>查询</button><button className="button button-secondary" onClick={resetFilters}>重置</button></div>
        </div>
      </section>

      <section className="panel sip-account-panel">
        <div className="sip-account-toolbar">
          <div><button className="button button-primary small-button" onClick={openNew}>＋ 新增</button><button className="button button-secondary small-button" onClick={() => notify("已进入批量新增向导，可按号码段创建账号")}>批量新增</button><button className="button button-secondary small-button" onClick={() => notify("请选择 CSV 或 XLSX 文件导入账号")}>导入</button><button className="button button-secondary small-button" onClick={() => notify(`已导出 ${filteredAccounts.length} 条账号记录`)}>导出</button></div>
          <span>共 {filteredAccounts.length} 条数据</span>
        </div>
        {selected.length > 0 && <div className="sip-batch-bar"><div><span>已选择 <b>{selected.length}</b> 个账号</span><button onClick={selectCurrentPage}>全选当前结果</button><button onClick={() => setSelected([])}>取消选择</button></div><div><select value={batchDepartment} onChange={(event) => setBatchDepartment(event.target.value)}>{zones.map((zone) => <option key={zone.name}>{zone.name}</option>)}<option>未分配</option></select><button className="button button-secondary small-button" onClick={assignDepartment}>归属分配</button><button className="button button-secondary small-button" onClick={() => { setAccounts((current) => current.map((account) => selected.includes(account.id) ? { ...account, enabled: true } : account)); notify(`已启用 ${selected.length} 个账号`); setSelected([]); }}>批量启用</button><button className="button button-danger-ghost small-button" onClick={() => setDeleteIds(selected)}>删除</button></div></div>}

        <div className="table-scroll"><table className="data-table sip-account-table"><thead><tr><th><input type="checkbox" checked={filteredAccounts.length > 0 && filteredAccounts.every((account) => selected.includes(account.id))} onChange={(event) => event.target.checked ? selectCurrentPage() : setSelected((current) => current.filter((id) => !filteredAccounts.some((account) => account.id === id)))} aria-label="全选当前账号" /></th><th>序号</th><th>账号类型</th><th>SIP 账号 / 名称</th><th>显示号码</th><th>鉴权</th><th>启用</th><th>质检</th><th>注册状态</th><th>部门</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{filteredAccounts.map((account, index) => <tr key={account.id} className={!account.enabled ? "disabled-row" : ""}><td><input type="checkbox" checked={selected.includes(account.id)} onChange={() => toggleSelected(account.id)} aria-label={`选择账号 ${account.account}`} /></td><td>{index + 1}</td><td><span className="sip-type-badge">SIP</span><small>{account.transport}</small></td><td><b className="mono account-number">{account.account}</b><small>{account.name}</small></td><td className="mono">{account.displayNumber}</td><td><span className="credential-state">••••••••</span><small>密钥已设置</small></td><td><button className={`account-enable-switch ${account.enabled ? "on" : ""}`} onClick={() => { setAccounts((current) => current.map((item) => item.id === account.id ? { ...item, enabled: !item.enabled, registration: item.enabled ? "未注册" : item.registration } : item)); notify(`${account.account} 已${account.enabled ? "停用" : "启用"}`); }} aria-label={`${account.enabled ? "停用" : "启用"}账号 ${account.account}`}><i /></button></td><td>{account.inspection ? <span className="yes-mark">启用</span> : <span className="no-mark">禁用</span>}</td><td><Status tone={account.registration === "在线" ? "success" : account.registration === "离线" ? "warning" : "neutral"}>{account.registration}</Status><small>{account.lastRegistered}</small></td><td>{account.department}</td><td>{account.createdAt}</td><td><div className="sip-row-actions"><button onClick={() => openEdit(account)}>修改</button><button onClick={() => notify(`账号 ${account.account} 的配置已复制，可新建后粘贴`)}>复制</button><button className="danger-link" onClick={() => setDeleteIds([account.id])}>删除</button></div></td></tr>)}</tbody></table></div>
        {filteredAccounts.length === 0 && <div className="sip-empty"><span>⌕</span><b>没有匹配的 SIP 账号</b><p>请调整查询条件后重试。</p><button className="text-button" onClick={resetFilters}>清除筛选</button></div>}
        <div className="pagination"><span>共 {filteredAccounts.length} 条数据 · 10 条/页</span><div><button disabled>‹</button><button className="active">1</button><button disabled={filteredAccounts.length <= 10}>2</button><button disabled>›</button></div></div>
      </section>

      {editor && <div className="modal-backdrop" onMouseDown={() => setEditor(null)}><div className="modal sip-editor-modal" role="dialog" aria-modal="true" aria-labelledby="sip-editor-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setEditor(null)}>×</button><div className="sip-editor-heading"><span>#</span><div><span className="section-kicker">PBX / 分机管理</span><h2 id="sip-editor-title">{editor.mode === "new" ? "新增 SIP 账号" : "修改 SIP 账号"}</h2><p>账号保存后，终端可使用分机号和鉴权密钥注册。</p></div></div><div className="sip-editor-form"><label><span>SIP 账号 <em>*</em></span><input value={editor.data.account} onChange={(event) => setEditor({ ...editor, data: { ...editor.data, account: event.target.value.replace(/\D/g, "") } })} placeholder="例如 86001" /></label><label><span>账号名称 <em>*</em></span><input value={editor.data.name} onChange={(event) => setEditor({ ...editor, data: { ...editor.data, name: event.target.value } })} placeholder="请输入终端或人员名称" /></label><label><span>显示号码</span><input value={editor.data.displayNumber} onChange={(event) => setEditor({ ...editor, data: { ...editor.data, displayNumber: event.target.value.replace(/\D/g, "") } })} placeholder="默认与 SIP 账号一致" /></label><label><span>鉴权密钥 {editor.mode === "new" && <em>*</em>}</span><div className="password-input"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={editor.mode === "edit" ? "留空表示不修改" : "至少 8 位字符"} /><button type="button" onClick={() => { const generated = `Sy${Math.random().toString(36).slice(2, 10)}!`; setPassword(generated); notify("已生成高强度鉴权密钥"); }}>生成</button></div></label><label><span>所属部门</span><select value={editor.data.department} onChange={(event) => setEditor({ ...editor, data: { ...editor.data, department: event.target.value } })}>{zones.map((zone) => <option key={zone.name}>{zone.name}</option>)}<option>未分配</option></select></label><label><span>传输协议</span><select value={editor.data.transport} onChange={(event) => setEditor({ ...editor, data: { ...editor.data, transport: event.target.value as SipAccount["transport"] } })}><option>UDP</option><option>TCP</option><option>TLS</option></select></label></div><div className="sip-editor-options"><label><input type="checkbox" checked={editor.data.enabled} onChange={(event) => setEditor({ ...editor, data: { ...editor.data, enabled: event.target.checked } })} /><span><b>启用账号</b><small>允许该账号向 SIP 服务发起注册</small></span></label><label><input type="checkbox" checked={editor.data.inspection} onChange={(event) => setEditor({ ...editor, data: { ...editor.data, inspection: event.target.checked } })} /><span><b>启用质检</b><small>保留该账号的广播执行与监听记录</small></span></label><label><input type="checkbox" checked={editor.data.international} onChange={(event) => setEditor({ ...editor, data: { ...editor.data, international: event.target.checked } })} /><span><b>允许国际外呼</b><small>广播终端通常无需开启</small></span></label></div><div className="sip-security-note"><span>⌾</span><p>鉴权密钥保存后不可再次查看。建议使用生成器，并通过安全渠道下发至终端。</p></div><div className="modal-actions"><button className="button button-secondary" onClick={() => setEditor(null)}>取消</button><button className="button button-primary" disabled={!editor.data.account || !editor.data.name || (editor.mode === "new" && password.length < 8)} onClick={saveAccount}>保存账号</button></div></div></div>}

      {deleteIds.length > 0 && <div className="modal-backdrop" onMouseDown={() => setDeleteIds([])}><div className="modal confirm-modal sip-delete-modal" role="dialog" aria-modal="true" aria-labelledby="sip-delete-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setDeleteIds([])}>×</button><div className="confirm-icon danger-confirm">!</div><h2 id="sip-delete-title">确认删除 SIP 账号？</h2><p>将删除 {deleteIds.length} 个账号并阻止其继续注册。相关历史任务和审计记录仍会保留。</p><div className="risk-note">此操作会中断已在线终端的后续注册，请确认账号不再使用。</div><div className="modal-actions"><button className="button button-secondary" onClick={() => setDeleteIds([])}>取消</button><button className="button button-danger-solid" onClick={confirmDelete}>确认删除</button></div></div></div>}
    </div>
  );
}

type ManagedZone = { id: number; name: string; description: string };

function Resources({ role, organizationName, onOrganizationSave, notify }: { role: Role; organizationName: string; onOrganizationSave: (name: string) => void; notify: (message: string) => void }) {
  const [managedZones, setManagedZones] = useState<ManagedZone[]>(zones.map((zone, index) => ({ id: index + 1, name: zone.name, description: index === 0 ? "教学楼宇及公共教室" : index === 1 ? "行政办公楼与会议区域" : index === 2 ? "学生生活与住宿区域" : index === 3 ? "广场、道路与校园出入口" : "体育馆、田径场及训练区域" })));
  const [managedTerminals, setManagedTerminals] = useState(terminalRows);
  const [selectedZoneId, setSelectedZoneId] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [zoneEditor, setZoneEditor] = useState<{ mode: "new" | "edit"; id?: number; name: string; description: string } | null>(null);
  const [organizationEditor, setOrganizationEditor] = useState<string | null>(null);
  const [assignmentZone, setAssignmentZone] = useState<ManagedZone | null>(null);
  const [assignedIds, setAssignedIds] = useState<string[]>([]);
  const [deleteZone, setDeleteZone] = useState<ManagedZone | null>(null);

  const selectedZone = selectedZoneId === "all" ? null : managedZones.find((zone) => zone.id === selectedZoneId) ?? null;
  const visibleTerminals = useMemo(() => managedTerminals.filter((terminal) => {
    const matchesZone = selectedZoneId === "all" ? true : selectedZoneId === -1 ? terminal.zone === "未分配" : terminal.zone === selectedZone?.name;
    const keyword = search.trim().toLowerCase();
    return matchesZone && (!keyword || `${terminal.name} ${terminal.id} ${terminal.extension} ${terminal.ip}`.toLowerCase().includes(keyword));
  }), [managedTerminals, search, selectedZone]);
  const onlineCount = managedTerminals.filter((terminal) => terminal.status === "在线空闲" || terminal.status === "播放中").length;

  const openAssignments = (zone: ManagedZone) => {
    setAssignmentZone(zone);
    setAssignedIds(managedTerminals.filter((terminal) => terminal.zone === zone.name).map((terminal) => terminal.id));
  };
  const saveZone = () => {
    if (!zoneEditor?.name.trim()) return;
    const name = zoneEditor.name.trim();
    if (zoneEditor.mode === "new") {
      const next: ManagedZone = { id: Math.max(0, ...managedZones.map((zone) => zone.id)) + 1, name, description: zoneEditor.description.trim() || "暂无分区说明" };
      setManagedZones((current) => [...current, next]);
      setSelectedZoneId(next.id);
      notify(`分区“${name}”已创建`);
    } else {
      const old = managedZones.find((zone) => zone.id === zoneEditor.id);
      setManagedZones((current) => current.map((zone) => zone.id === zoneEditor.id ? { ...zone, name, description: zoneEditor.description.trim() || "暂无分区说明" } : zone));
      if (old) setManagedTerminals((current) => current.map((terminal) => terminal.zone === old.name ? { ...terminal, zone: name } : terminal));
      notify(`分区“${name}”已更新`);
    }
    setZoneEditor(null);
  };
  const saveAssignments = () => {
    if (!assignmentZone) return;
    setManagedTerminals((current) => current.map((terminal) => terminal.zone === assignmentZone.name && !assignedIds.includes(terminal.id) ? { ...terminal, zone: "未分配" } : assignedIds.includes(terminal.id) ? { ...terminal, zone: assignmentZone.name } : terminal));
    notify(`已更新“${assignmentZone.name}”的终端配置`);
    setAssignmentZone(null);
  };
  const confirmDeleteZone = () => {
    if (!deleteZone) return;
    setManagedZones((current) => current.filter((zone) => zone.id !== deleteZone.id));
    setManagedTerminals((current) => current.map((terminal) => terminal.zone === deleteZone.name ? { ...terminal, zone: "未分配" } : terminal));
    if (selectedZoneId === deleteZone.id) setSelectedZoneId("all");
    notify(`分区“${deleteZone.name}”已删除，原终端已移至未分配`);
    setDeleteZone(null);
  };

  return <div className="page zone-management-page">
    <div className="page-heading split-heading"><div><div className="breadcrumb">资源管理 / 分区管理</div><h1>分区管理</h1><p>维护组织与广播分区，并配置每个分区所包含的 SIP 广播终端。</p></div><div className="heading-actions"><button className="button button-secondary" disabled={role !== "系统管理员"} onClick={() => setOrganizationEditor(organizationName)}>编辑组织</button><button className="button button-primary" disabled={role !== "系统管理员"} onClick={() => setZoneEditor({ mode: "new", name: "", description: "" })}>＋ 新建分区</button></div></div>
    {role !== "系统管理员" && <div className="permission-notice">当前为只读模式。如需修改组织、分区或终端归属，请在右上角切换为“系统管理员”。</div>}
    <section className="organization-banner"><div className="organization-banner-mark">{organizationName.slice(0, 2)}</div><div><span>当前组织</span><h2>{organizationName}</h2><p>{managedZones.length} 个广播分区 · {managedTerminals.length} 台已录入终端</p></div><button className="text-button" disabled={role !== "系统管理员"} onClick={() => setOrganizationEditor(organizationName)}>修改组织名称</button></section>
    <section className="zone-overview-grid"><div><span>广播分区</span><b>{managedZones.length}</b><small>均可独立选择广播</small></div><div><span>已分配终端</span><b>{managedTerminals.filter((terminal) => terminal.zone !== "未分配").length}</b><small>共 {managedTerminals.length} 台终端</small></div><div><span>在线终端</span><b className="green">{onlineCount}</b><small>当前样例终端状态</small></div><div><span>未分配终端</span><b className="orange">{managedTerminals.filter((terminal) => terminal.zone === "未分配").length}</b><small>建议及时归入分区</small></div></section>

    <div className="zone-management-layout">
      <aside className="panel managed-zone-list"><div className="managed-zone-heading"><div><span className="section-kicker">组织结构</span><h2>广播分区</h2></div><button disabled={role !== "系统管理员"} onClick={() => setZoneEditor({ mode: "new", name: "", description: "" })}>＋</button></div><button className={`managed-zone-item ${selectedZoneId === "all" ? "active" : ""}`} onClick={() => setSelectedZoneId("all")}><span className="zone-folder root">⌂</span><span><b>全部终端</b><small>{organizationName}</small></span><em>{managedTerminals.length}</em></button>{managedZones.map((zone) => { const count = managedTerminals.filter((terminal) => terminal.zone === zone.name).length; return <button className={`managed-zone-item ${selectedZoneId === zone.id ? "active" : ""}`} key={zone.id} onClick={() => setSelectedZoneId(zone.id)}><span className="zone-folder">▰</span><span><b>{zone.name}</b><small>{zone.description}</small></span><em>{count}</em></button>; })}<button className={`managed-zone-item unassigned ${selectedZoneId === -1 ? "active" : ""}`} onClick={() => setSelectedZoneId(-1)}><span className="zone-folder">?</span><span><b>未分配终端</b><small>尚未加入任何分区</small></span><em>{managedTerminals.filter((terminal) => terminal.zone === "未分配").length}</em></button></aside>

      <section className="panel zone-terminal-panel"><div className="zone-terminal-heading"><div><span className="section-kicker">{selectedZone ? "分区详情" : selectedZoneId === -1 ? "待处理" : "终端总览"}</span><h2>{selectedZone?.name ?? (selectedZoneId === -1 ? "未分配终端" : organizationName)}</h2><p>{selectedZone?.description ?? (selectedZoneId === -1 ? "将终端配置到合适的广播分区" : `查看 ${managedZones.length} 个分区中的全部终端`)}</p></div>{selectedZone && <div className="zone-heading-actions"><button className="button button-secondary small-button" disabled={role !== "系统管理员"} onClick={() => setZoneEditor({ mode: "edit", id: selectedZone.id, name: selectedZone.name, description: selectedZone.description })}>编辑分区</button><button className="button button-primary small-button" disabled={role !== "系统管理员"} onClick={() => openAssignments(selectedZone)}>配置终端</button><button className="zone-delete-button" disabled={role !== "系统管理员"} onClick={() => setDeleteZone(selectedZone)}>删除</button></div>}</div><div className="zone-terminal-toolbar"><label className="search-field compact"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索终端名称、编号、分机或 IP" /></label><span>当前显示 {visibleTerminals.length} 台</span></div><div className="table-scroll"><table className="data-table managed-terminal-table"><thead><tr><th>终端名称 / 编号</th><th>SIP 分机</th><th>类型</th><th>所属分区</th><th>位置</th><th>IP 地址</th><th>状态</th></tr></thead><tbody>{visibleTerminals.map((terminal) => <tr key={terminal.id}><td><b>{terminal.name}</b><small>{terminal.id}</small></td><td className="mono">{terminal.extension}</td><td>{terminal.type}</td><td><span className={terminal.zone === "未分配" ? "unassigned-tag" : "zone-name-tag"}>{terminal.zone}</span></td><td>{terminal.location}</td><td className="mono">{terminal.ip}</td><td><Status tone={terminal.status === "在线空闲" || terminal.status === "播放中" ? "success" : terminal.status === "异常" ? "danger" : "neutral"}>{terminal.status}</Status></td></tr>)}</tbody></table></div>{visibleTerminals.length === 0 && <div className="zone-terminal-empty"><span>▰</span><b>该范围内暂无终端</b><p>{selectedZone ? "点击“配置终端”添加终端" : "请调整搜索条件"}</p></div>}<div className="pagination"><span>共 {visibleTerminals.length} 台终端</span><div><button disabled>‹</button><button className="active">1</button><button disabled>›</button></div></div></section>
    </div>

    {organizationEditor !== null && <div className="modal-backdrop" onMouseDown={() => setOrganizationEditor(null)}><div className="modal organization-editor-modal" role="dialog" aria-modal="true" aria-labelledby="organization-editor-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setOrganizationEditor(null)}>×</button><div className="confirm-icon">⌂</div><h2 id="organization-editor-title">修改组织名称</h2><p>保存后将同步更新顶部栏、实时广播目标树和分区管理页面。</p><label className="modal-field"><span>组织名称</span><input value={organizationEditor} maxLength={30} autoFocus onChange={(event) => setOrganizationEditor(event.target.value)} /><small>{organizationEditor.length}/30</small></label><div className="modal-actions"><button className="button button-secondary" onClick={() => setOrganizationEditor(null)}>取消</button><button className="button button-primary" disabled={!organizationEditor.trim()} onClick={() => { onOrganizationSave(organizationEditor.trim()); notify("组织名称已更新"); setOrganizationEditor(null); }}>保存</button></div></div></div>}
    {zoneEditor && <div className="modal-backdrop" onMouseDown={() => setZoneEditor(null)}><div className="modal zone-editor-modal" role="dialog" aria-modal="true" aria-labelledby="zone-editor-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setZoneEditor(null)}>×</button><div className="confirm-icon">▰</div><h2 id="zone-editor-title">{zoneEditor.mode === "new" ? "新建广播分区" : "编辑广播分区"}</h2><p>分区名称将用于实时广播和定时计划的目标选择。</p><div className="zone-editor-form"><label><span>分区名称 <em>*</em></span><input value={zoneEditor.name} autoFocus maxLength={20} onChange={(event) => setZoneEditor({ ...zoneEditor, name: event.target.value })} placeholder="例如：教学楼" /></label><label><span>分区说明</span><textarea value={zoneEditor.description} maxLength={80} onChange={(event) => setZoneEditor({ ...zoneEditor, description: event.target.value })} placeholder="填写覆盖区域或使用说明" /></label></div><div className="modal-actions"><button className="button button-secondary" onClick={() => setZoneEditor(null)}>取消</button><button className="button button-primary" disabled={!zoneEditor.name.trim() || managedZones.some((zone) => zone.name === zoneEditor.name.trim() && zone.id !== zoneEditor.id)} onClick={saveZone}>保存分区</button></div></div></div>}
    {assignmentZone && <div className="modal-backdrop" onMouseDown={() => setAssignmentZone(null)}><div className="modal zone-assignment-modal" role="dialog" aria-modal="true" aria-labelledby="zone-assignment-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setAssignmentZone(null)}>×</button><div className="zone-assignment-heading"><span>▦</span><div><span className="section-kicker">终端归属</span><h2 id="zone-assignment-title">配置“{assignmentZone.name}”的终端</h2><p>勾选需要加入此分区的终端，终端只能归属于一个分区。</p></div></div><div className="assignment-summary"><span>已选择 <b>{assignedIds.length}</b> 台终端</span><button className="text-button" onClick={() => setAssignedIds(managedTerminals.map((terminal) => terminal.id))}>全选</button><button className="text-button" onClick={() => setAssignedIds([])}>清空</button></div><div className="assignment-terminal-list">{managedTerminals.map((terminal) => <label key={terminal.id} className={assignedIds.includes(terminal.id) ? "selected" : ""}><input type="checkbox" checked={assignedIds.includes(terminal.id)} onChange={() => setAssignedIds((current) => current.includes(terminal.id) ? current.filter((id) => id !== terminal.id) : [...current, terminal.id])} /><span className={`terminal-device-icon ${terminal.type === "SIP 网关" ? "gateway" : ""}`}>{terminal.type === "SIP 网关" ? "GW" : "◖"}</span><span><b>{terminal.name}</b><small>{terminal.id} · 分机 {terminal.extension}</small></span><em>{terminal.zone}</em></label>)}</div><div className="modal-actions"><button className="button button-secondary" onClick={() => setAssignmentZone(null)}>取消</button><button className="button button-primary" onClick={saveAssignments}>保存终端配置</button></div></div></div>}
    {deleteZone && <div className="modal-backdrop" onMouseDown={() => setDeleteZone(null)}><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-zone-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setDeleteZone(null)}>×</button><div className="confirm-icon danger-confirm">!</div><h2 id="delete-zone-title">删除“{deleteZone.name}”？</h2><p>删除后，该分区内的终端将移至“未分配终端”，不会删除终端本身。</p><div className="modal-actions"><button className="button button-secondary" onClick={() => setDeleteZone(null)}>取消</button><button className="button button-danger-solid" onClick={confirmDeleteZone}>确认删除</button></div></div></div>}
  </div>;
}

const taskStatusLabel: Record<BroadcastTask["status"], string> = {
  dispatching: "下发中",
  accepted: "已接受",
  partial: "部分接受",
  failed: "下发失败",
  cancelled: "已取消",
};

function Tasks() {
  const [tab, setTab] = useState("全部任务");
  const [liveTasks, setLiveTasks] = useState<BroadcastTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const load = () => controlApi<{ items: BroadcastTask[] }>("broadcasts?limit=50")
      .then(({ items }) => { if (active) { setLiveTasks(items); setError(""); } })
      .catch((requestError) => { if (active) setError(requestError.message); })
      .finally(() => { if (active) setLoading(false); });
    load();
    const timer = window.setInterval(load, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const cancelTask = async (id: string) => {
    try {
      const { task } = await controlApi<{ task: BroadcastTask }>(`broadcasts/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
      setLiveTasks((current) => current.map((item) => item.id === task.id ? task : item));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "停止任务失败");
    }
  };

  return <div className="page"><div className="page-heading split-heading"><div><div className="breadcrumb">广播中心 / 任务中心</div><h1>任务中心</h1><p>统一查看广播队列、执行进度、设备级结果和历史记录。</p></div><button className="button button-secondary">导出当前列表</button></div>
    <section className="panel tasks-card"><div className="table-toolbar"><div className="tabs">{["全部任务", "进行中 1", "待执行 6", "异常 2", "已完成"].map((item) => <button key={item} onClick={() => setTab(item)} className={tab === item ? "active" : ""}>{item}</button>)}</div><div className="toolbar-actions"><label className="search-field compact"><span>⌕</span><input placeholder="搜索任务名称或编号" /></label><button className="button button-secondary small-button">筛选</button></div></div>
    {error && <div className="risk-note">控制服务暂不可用：{error}</div>}
    <table className="data-table task-table"><thead><tr><th>任务 / 编号</th><th>类型</th><th>目标范围</th><th>设备结果</th><th>状态</th><th>发起时间</th><th>操作</th></tr></thead><tbody>
      {liveTasks.map((task) => { const accepted = task.targets.filter((target) => target.status === "accepted").length; return <tr key={task.id}><td><b>{task.name}</b><small>{task.id}</small></td><td>实时广播</td><td>{task.targets.map((target) => target.extension).join("、")}</td><td><div className="result-progress"><span><i style={{ width: `${task.targets.length ? accepted / task.targets.length * 100 : 0}%` }} /></span><b>{accepted} / {task.targets.length} 已接受</b></div></td><td><Status tone={task.status === "accepted" ? "success" : task.status === "failed" ? "danger" : "warning"}>{taskStatusLabel[task.status]}</Status></td><td>{new Date(task.createdAt).toLocaleString("zh-CN", { hour12: false })}</td><td>{!["cancelled", "failed"].includes(task.status) ? <button className="link-action" onClick={() => cancelTask(task.id)}>停止</button> : <button className="link-action" disabled>详情</button>}</td></tr>; })}
      {!liveTasks.length && !loading && taskRows.map((row) => <tr key={row.id}><td><b>{row.name}</b><small>{row.id} · 原型示例</small></td><td>{row.type}</td><td>{row.target}</td><td><div className="result-progress"><span><i style={{ width: `${parseInt(row.progress) / parseInt(row.progress.split("/")[1]) * 100}%` }} /></span><b>{row.progress}</b></div></td><td><Status tone={row.status === "播放中" || row.status === "成功" ? "success" : "warning"}>{row.status}</Status></td><td>08-10 {row.time}</td><td><button className="link-action">详情</button></td></tr>)}
      {loading && <tr><td colSpan={7}>正在读取实时任务…</td></tr>}
    </tbody></table></section>
    <div className="task-insight-grid"><section className="panel"><span className="section-kicker">执行质量</span><h2>今日任务结果</h2><div className="donut-row"><div className="donut"><span>98.4%<small>成功率</small></span></div><div className="legend-list"><div><i className="green-bg" />成功确认<b>3,426</b></div><div><i className="orange-bg" />推定完成<b>41</b></div><div><i className="red-bg" />失败 / 未知<b>16</b></div></div></div></section><section className="panel"><span className="section-kicker">失败原因</span><h2>需要关注的问题</h2><div className="reason-bars"><div><span>终端离线</span><i><b style={{ width: "78%" }} /></i><em>8</em></div><div><span>媒体不可达</span><i><b style={{ width: "48%" }} /></i><em>5</em></div><div><span>能力不兼容</span><i><b style={{ width: "28%" }} /></i><em>3</em></div></div></section></div>
  </div>;
}

function Permissions({ role }: { role: Role }) {
  return <div className="page"><div className="page-heading split-heading"><div><div className="breadcrumb">系统管理 / 用户与权限</div><h1>用户与权限</h1><p>首版采用系统管理员、广播操作员两个固定角色，权限边界清晰可控。</p></div><button className="button button-primary" disabled={role !== "系统管理员"}>＋ 新增用户</button></div>
    <div className="role-summary-grid"><article className="role-card admin"><div className="role-card-top"><span className="avatar role-avatar">管</span><Status tone="info">系统内置</Status></div><h2>系统管理员</h2><p>负责平台配置、设备运维、用户权限与系统安全，可配置是否参与广播业务。</p><div><span>当前用户</span><b>3 人</b></div></article><article className="role-card operator"><div className="role-card-top"><span className="avatar role-avatar">播</span><Status tone="success">系统内置</Status></div><h2>广播操作员</h2><p>执行日常广播、计划、媒体与任务处理，仅访问被授权分区的数据。</p><div><span>当前用户</span><b>12 人</b></div></article><article className="role-note"><span>i</span><div><b>为什么首版固定两个角色？</b><p>降低授权复杂度，便于试点阶段验证业务边界。自定义角色计划在 V1.1 提供。</p></div></article></div>
    <section className="panel permission-matrix"><div className="panel-title-row"><div><span className="section-kicker">权限基线</span><h2>预置角色权限矩阵</h2></div><button className="text-button">查看权限说明</button></div><table className="data-table"><thead><tr><th>能力</th><th><span className="role-head admin-head">管</span>系统管理员</th><th><span className="role-head operator-head">播</span>广播操作员</th></tr></thead><tbody>{permissionRows.map((row) => <tr key={row[0]}><td><b>{row[0]}</b></td><td>{row[1]}</td><td>{row[2]}</td></tr>)}</tbody></table></section>
    <section className="panel user-list"><div className="panel-title-row"><div><span className="section-kicker">账号</span><h2>最近活跃用户</h2></div><button className="text-button">查看全部用户</button></div><div className="user-rows"><div><span className="avatar">林</span><span><b>林值班员</b><small>lin.operator · 广播操作员</small></span><Status tone="success">在线</Status><em>刚刚</em></div><div><span className="avatar blue-avatar">周</span><span><b>周系统管理员</b><small>zhou.admin · 系统管理员</small></span><Status tone="success">在线</Status><em>6 分钟前</em></div><div><span className="avatar violet-avatar">陈</span><span><b>陈广播员</b><small>chen.operator · 广播操作员</small></span><Status>离线</Status><em>昨天 18:32</em></div></div></section>
  </div>;
}

function SystemConfig({ organizationName, onSave, notify }: { organizationName: string; onSave: (name: string) => void; notify: (message: string) => void }) {
  const [draftName, setDraftName] = useState(organizationName);
  const [organizationCode, setOrganizationCode] = useState("CAMPUS-BROADCAST");
  const [contact, setContact] = useState("信息化中心");
  const [phone, setPhone] = useState("010-6789 1234");
  const [dirty, setDirty] = useState(false);

  const updateName = (value: string) => { setDraftName(value); setDirty(true); };
  const save = () => {
    const nextName = draftName.trim();
    if (!nextName) return;
    onSave(nextName);
    setDraftName(nextName);
    setDirty(false);
    notify("组织信息已保存，并同步更新到系统界面");
  };

  return <div className="page system-config-page">
    <div className="page-heading split-heading"><div><div className="breadcrumb">系统管理 / 系统配置</div><h1>系统配置</h1><p>维护组织信息及 SIP 广播系统的基础运行参数。</p></div>{dirty && <span className="unsaved-badge">● 有未保存的修改</span>}</div>
    <div className="system-config-layout">
      <aside className="panel config-nav"><span>配置分类</span><button className="active"><i>◎</i><b>组织信息</b><em>›</em></button><button><i>#</i><b>SIP 服务</b><em>›</em></button><button><i>♪</i><b>媒体与转码</b><em>›</em></button><button><i>◷</i><b>时间与日历</b><em>›</em></button><button><i>▣</i><b>存储设置</b><em>›</em></button></aside>
      <div className="config-content">
        <section className="panel organization-card"><div className="panel-title-row"><div><span className="section-kicker">基础设置</span><h2>组织信息</h2><p>组织名称会显示在顶部栏、实时广播目标树和资源分区树中。</p></div><span className="organization-preview-mark">{(draftName.trim() || "组织").slice(0, 2)}</span></div><div className="organization-form"><label className="wide"><span>组织名称 <em>*</em></span><input value={draftName} maxLength={30} onChange={(event) => updateName(event.target.value)} placeholder="请输入组织名称" /><small>{draftName.length}/30，将同步显示在系统主要界面</small></label><label><span>组织编码</span><input value={organizationCode} onChange={(event) => { setOrganizationCode(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "")); setDirty(true); }} placeholder="例如 CAMPUS-BROADCAST" /></label><label><span>所属时区</span><select defaultValue="Asia/Shanghai"><option>Asia/Shanghai（UTC+8）</option></select></label><label><span>管理部门</span><input value={contact} onChange={(event) => { setContact(event.target.value); setDirty(true); }} /></label><label><span>联系电话</span><input value={phone} onChange={(event) => { setPhone(event.target.value); setDirty(true); }} /></label></div><div className="organization-actions"><button className="button button-secondary" disabled={!dirty} onClick={() => { setDraftName(organizationName); setOrganizationCode("CAMPUS-BROADCAST"); setContact("信息化中心"); setPhone("010-6789 1234"); setDirty(false); }}>取消修改</button><button className="button button-primary" disabled={!dirty || !draftName.trim()} onClick={save}>保存设置</button></div></section>
        <section className="panel config-sync-card"><span className="config-sync-icon">↻</span><div><b>名称同步范围</b><p>保存组织名称后，以下位置会立即使用新名称。</p><div className="sync-tags"><span>顶部导航栏</span><span>实时广播目标树</span><span>分区资源树</span></div></div></section>
      </div>
    </div>
  </div>;
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
  const [page, setPage] = useState<PageKey>("overview");
  const [role, setRole] = useState<Role>("广播操作员");
  const [roleMenu, setRoleMenu] = useState(false);
  const [toast, setToast] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [organizationName, setOrganizationName] = useState("校园广播组织");

  const pageLabel = navGroups.flatMap(g => g.items).find(item => item.key === page)?.label ?? "运行总览";
  const go = (next: PageKey) => { setPage(next); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 3600); };

  return (
    <main className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><i /><i /><i /></span><span><b>SIP广播系统</b><small>SIP BROADCAST</small></span></div>
        <nav aria-label="主导航">
          {navGroups.map((group) => <div className="nav-group" key={group.label}><div className="nav-group-label">{group.label}</div>{group.items.map((item) => <button key={item.key} className={page === item.key ? "active" : ""} onClick={() => go(item.key)} title={collapsed ? item.label : undefined}><Icon>{item.icon}</Icon><span>{item.label}</span>{item.badge && <em>{item.badge}</em>}</button>)}</div>)}
        </nav>
        <div className="system-health"><div><i /><span><b>系统运行正常</b><small>所有核心服务可用</small></span></div><button>›</button></div>
        <button className="collapse-button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}>{collapsed ? "›" : "‹"}</button>
      </aside>
      <section className="main-area">
        <header className="topbar">
          <div className="topbar-context"><b>{pageLabel}</b><span>{organizationName}</span></div>
          <div className="topbar-right"><TopActions /><div className="profile-wrap"><button className="profile" onClick={() => setRoleMenu(!roleMenu)} aria-expanded={roleMenu}><span className="avatar">{role === "系统管理员" ? "周" : "林"}</span><span><b>{role === "系统管理员" ? "周系统管理员" : "林值班员"}</b><small>{role}</small></span><em>⌄</em></button>{roleMenu && <div className="role-menu"><span>原型角色视角</span><button className={role === "广播操作员" ? "active" : ""} onClick={() => { setRole("广播操作员"); setRoleMenu(false); }}><i className="avatar mini">林</i><span><b>林值班员</b><small>广播操作员</small></span>{role === "广播操作员" && <em>✓</em>}</button><button className={role === "系统管理员" ? "active" : ""} onClick={() => { setRole("系统管理员"); setRoleMenu(false); }}><i className="avatar mini blue-avatar">周</i><span><b>周系统管理员</b><small>系统管理员</small></span>{role === "系统管理员" && <em>✓</em>}</button></div>}</div></div>
        </header>

        {page === "overview" && <Overview go={go} />}
        {page === "realtime" && <Realtime organizationName={organizationName} onStarted={(task) => { const accepted = task.targets.filter((target) => target.status === "accepted").length; notify(`广播任务 ${task.id} 已创建，FreeSWITCH 已接受 ${accepted}/${task.targets.length} 个目标`); go("tasks"); }} />}
        {page === "schedule" && <Schedule notify={notify} />}
        {page === "terminals" && <Terminals notify={notify} />}
        {page === "resources" && <Resources role={role} organizationName={organizationName} onOrganizationSave={setOrganizationName} notify={notify} />}
        {page === "tasks" && <Tasks />}
        {page === "sipAccounts" && <SipAccounts notify={notify} />}
        {page === "permissions" && <Permissions role={role} />}
        {page === "system" && <SystemConfig organizationName={organizationName} onSave={setOrganizationName} notify={notify} />}
        {!(["overview", "realtime", "schedule", "terminals", "resources", "tasks", "sipAccounts", "permissions", "system"] as PageKey[]).includes(page) && <PlaceholderPage page={page} />}
      </section>

      {toast && <div className="toast"><span>✓</span><div><b>操作成功</b><p>{toast}</p></div><button onClick={() => setToast("")}>×</button></div>}
    </main>
  );
}
