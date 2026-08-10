"use client";

import { useMemo, useState } from "react";

type PageKey =
  | "overview"
  | "realtime"
  | "schedule"
  | "tasks"
  | "emergency"
  | "content"
  | "resources"
  | "alarms"
  | "reports"
  | "permissions"
  | "system";

type Role = "系统管理员" | "广播操作员";

const navGroups: Array<{ label: string; items: Array<{ key: PageKey; label: string; icon: string; badge?: string }> }> = [
  { label: "工作台", items: [{ key: "overview", label: "运行总览", icon: "⌂" }] },
  {
    label: "广播业务",
    items: [
      { key: "realtime", label: "实时广播", icon: "◉" },
      { key: "schedule", label: "定时计划", icon: "◷" },
      { key: "tasks", label: "任务中心", icon: "≡", badge: "3" },
      { key: "emergency", label: "应急预案", icon: "⚡" },
      { key: "content", label: "内容中心", icon: "♪" },
    ],
  },
  {
    label: "运营管理",
    items: [
      { key: "resources", label: "分区与设备", icon: "⌘" },
      { key: "alarms", label: "监控告警", icon: "△", badge: "4" },
      { key: "reports", label: "报表审计", icon: "▦" },
    ],
  },
  {
    label: "系统",
    items: [
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

const deviceRows = [
  { id: "SPK-A1-001", name: "教学楼 A1 一层走廊音箱", zone: "教学楼 / A1", ip: "10.20.1.31", type: "IP 音箱", status: "在线空闲", last: "刚刚" },
  { id: "SPK-A1-002", name: "教学楼 A1 二层走廊音箱", zone: "教学楼 / A1", ip: "10.20.1.32", type: "IP 音箱", status: "播放中", last: "刚刚" },
  { id: "SPK-D3-018", name: "宿舍 D3 东侧音柱", zone: "学生宿舍区 / D3", ip: "10.20.8.18", type: "IP 音柱", status: "离线", last: "12 分钟前" },
  { id: "GW-GYM-01", name: "体育馆模拟广播网关", zone: "体育场馆 / 体育馆", ip: "10.20.12.9", type: "SIP 网关", status: "在线空闲", last: "1 分钟前" },
  { id: "SPK-SQ-021", name: "中心广场东侧音柱", zone: "室外公共区 / 中心广场", ip: "10.20.15.21", type: "IP 音柱", status: "异常", last: "3 分钟前" },
];

const taskRows = [
  { id: "JOB-260810-0082", name: "午间校园音乐", type: "定时广播", target: "室外公共区等 3 个分区", progress: "126 / 128", status: "播放中", time: "12:00:00" },
  { id: "JOB-260810-0081", name: "教学楼下课铃", type: "定时广播", target: "教学楼", progress: "84 / 86", status: "部分成功", time: "11:40:00" },
  { id: "JOB-260810-0080", name: "消防演练预案测试", type: "演练任务", target: "行政办公区", progress: "42 / 42", status: "成功", time: "10:10:21" },
  { id: "JOB-260810-0079", name: "临时失物招领通知", type: "实时广播", target: "学生宿舍区", progress: "125 / 128", status: "成功", time: "09:36:42" },
];

const permissionRows = [
  ["查看总览与任务", "全部数据", "授权分区及本人相关任务"],
  ["发起实时广播", "可配置", "是，受数据范围和高风险规则约束"],
  ["创建 / 启用计划", "可配置", "是，受数据范围和内容状态约束"],
  ["触发应急预案", "可配置", "需专项授权和二次确认"],
  ["停止他人任务", "是", "默认否；应急任务可专项授权"],
  ["管理设备 / 分区", "新增、编辑、导入、诊断", "只读，可查看状态和任务结果"],
  ["用户与系统配置", "是", "否"],
  ["导出 / 审计", "全部", "本人及授权分区范围"],
];

function Icon({ children }: { children: string }) {
  return <span className="nav-icon" aria-hidden="true">{children}</span>;
}

function Status({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "success" | "warning" | "danger" | "info" | "neutral" }) {
  return <span className={`status status-${tone}`}><i />{children}</span>;
}

function TopActions({ onEmergency }: { onEmergency: () => void }) {
  return (
    <div className="top-actions">
      <button className="icon-button" aria-label="搜索">⌕</button>
      <button className="icon-button notification" aria-label="通知">♢<b>4</b></button>
      <span className="top-divider" />
      <button className="emergency-button" onClick={onEmergency}>⚡ 触发应急预案</button>
    </div>
  );
}

function Overview({ go, onEmergency }: { go: (page: PageKey) => void; onEmergency: () => void }) {
  return (
    <div className="page overview-page">
      <div className="page-heading split-heading">
        <div>
          <div className="eyebrow">2026 年 8 月 10 日 · 星期一</div>
          <h1>早上好，林值班员</h1>
          <p>广播系统运行平稳，当前有 1 个任务正在播放，4 条告警待处理。</p>
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
        <article className="metric-card accent-orange" onClick={() => go("alarms")} role="button" tabIndex={0}>
          <div className="metric-top"><span className="metric-icon">△</span><span className="trend warning-text">2 条重要</span></div>
          <strong>4</strong>
          <h3>待处理告警</h3>
          <p>较昨日减少 3 条</p>
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

      <div className="lower-grid">
        <section className="panel zone-panel">
          <div className="panel-title-row"><div><span className="section-kicker">资源概览</span><h2>分区运行情况</h2></div><button className="text-button" onClick={() => go("resources")}>管理分区与设备</button></div>
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
        <section className="panel alarm-panel">
          <div className="panel-title-row"><div><span className="section-kicker">实时动态</span><h2>重点告警</h2></div><button className="text-button" onClick={() => go("alarms")}>进入告警中心</button></div>
          <div className="alarm-list">
            <div className="alarm-item high"><span className="alarm-mark">!</span><div><b>中心广场东侧音柱媒体连接失败</b><p>SPK-SQ-021 · 已持续 8 分钟</p></div><time>12:06</time></div>
            <div className="alarm-item high"><span className="alarm-mark">!</span><div><b>宿舍 D3 东侧音柱离线</b><p>SPK-D3-018 · 已持续 12 分钟</p></div><time>12:02</time></div>
            <div className="alarm-item"><span className="alarm-mark">i</span><div><b>教学楼 A1 二层任务部分失败</b><p>JOB-260810-0081 · 2 台未确认</p></div><time>11:42</time></div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Realtime({ onStarted }: { onStarted: () => void }) {
  const [selectedZones, setSelectedZones] = useState(["教学楼", "行政办公区"]);
  const [source, setSource] = useState("audio");
  const [confirm, setConfirm] = useState(false);
  const [search, setSearch] = useState("");

  const toggleZone = (name: string) => setSelectedZones((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  const selectedDevices = zones.filter((z) => selectedZones.includes(z.name)).reduce((sum, z) => sum + z.device, 0);
  const onlineDevices = zones.filter((z) => selectedZones.includes(z.name)).reduce((sum, z) => sum + z.online, 0);

  return (
    <div className="page realtime-page">
      <div className="page-heading">
        <div className="breadcrumb">广播中心 / 实时广播</div>
        <h1>发起实时广播</h1>
        <p>选择目标与音频来源，预检通过后立即建立广播任务。</p>
      </div>

      <div className="steps" aria-label="广播配置步骤">
        <div className="step active"><span>1</span><div><b>选择目标</b><small>{selectedZones.length} 个分区</small></div></div>
        <i />
        <div className="step active"><span>2</span><div><b>选择音源</b><small>校园安全提示音</small></div></div>
        <i />
        <div className="step"><span>3</span><div><b>执行策略</b><small>优先级与音量</small></div></div>
      </div>

      <div className="broadcast-builder">
        <section className="builder-card target-picker">
          <div className="builder-title"><div><span>01</span><h2>选择广播目标</h2></div><button className="text-button" onClick={() => setSelectedZones(zones.map(z => z.name))}>全选</button></div>
          <label className="search-field"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索分区或设备" /></label>
          <div className="tree-root"><span className="tree-toggle">⌄</span><b>校园广播组织</b><small>356 台</small></div>
          <div className="zone-check-list">
            {zones.filter(z => z.name.includes(search)).map((zone) => (
              <label className="zone-check" key={zone.name}>
                <input type="checkbox" checked={selectedZones.includes(zone.name)} onChange={() => toggleZone(zone.name)} />
                <span className="custom-check">✓</span>
                <span className="folder">▰</span>
                <span><b>{zone.name}</b><small>{zone.online} / {zone.device} 台在线</small></span>
                {zone.tag && <em>{zone.tag}</em>}
              </label>
            ))}
          </div>
          <div className="selection-summary"><div><strong>{selectedZones.length}</strong><span>已选分区</span></div><div><strong>{selectedDevices}</strong><span>目标设备</span></div><div><strong className="success-number">{onlineDevices}</strong><span>当前在线</span></div></div>
        </section>

        <section className="builder-card source-picker">
          <div className="builder-title"><div><span>02</span><h2>选择音频来源</h2></div></div>
          <div className="segmented">
            <button className={source === "audio" ? "active" : ""} onClick={() => setSource("audio")}>♪ 音频库</button>
            <button className={source === "mic" ? "active" : ""} onClick={() => setSource("mic")}>◉ 麦克风</button>
            <button className={source === "template" ? "active" : ""} onClick={() => setSource("template")}>▦ 广播模板</button>
          </div>
          {source === "audio" && <>
            <label className="search-field"><span>⌕</span><input placeholder="搜索音频名称" /></label>
            <div className="audio-list">
              <button className="audio-row selected"><span className="play-circle">▶</span><span><b>校园安全提示音.mp3</b><small>00:28 · 安全提示</small></span><em>已选择</em></button>
              <button className="audio-row"><span className="play-circle">▶</span><span><b>午间校园音乐.mp3</b><small>05:58 · 日常音乐</small></span></button>
              <button className="audio-row"><span className="play-circle">▶</span><span><b>临时通知前奏.wav</b><small>00:06 · 提示音</small></span></button>
            </div>
          </>}
          {source === "mic" && <div className="source-empty"><div className="mic-orb">◉</div><h3>浏览器麦克风实时广播</h3><p>开始前会检测浏览器授权、输入设备和媒体链路。</p><button className="button button-secondary">检测麦克风</button></div>}
          {source === "template" && <div className="template-list"><button className="template-card selected"><b>校园安全提醒</b><span>安全提示音 · 全文 28 秒</span></button><button className="template-card"><b>失物招领通知</b><span>前奏 + TTS 动态文本</span></button><button className="template-card"><b>临时闭馆通知</b><span>提示音 + 闭馆文案</span></button></div>}
        </section>

        <section className="builder-card strategy-card">
          <div className="builder-title"><div><span>03</span><h2>执行策略</h2></div></div>
          <label className="form-label">广播优先级<select defaultValue="P1"><option value="P0">P0 紧急</option><option value="P1">P1 高</option><option value="P2">P2 普通</option><option value="P3">P3 测试</option></select></label>
          <div className="form-label"><span>播放音量</span><div className="range-line"><input type="range" min="0" max="100" defaultValue="75" /><b>75%</b></div></div>
          <label className="switch-line"><span><b>循环播放</b><small>内容结束后继续播放</small></span><input type="checkbox" /><i /></label>
          <label className="switch-line"><span><b>强制音量</b><small>临时覆盖终端本地音量</small></span><input type="checkbox" defaultChecked /><i /></label>
          <label className="form-label">结束策略<select defaultValue="content"><option value="content">内容播放完毕后结束</option><option value="manual">由操作员手动结束</option></select></label>
          <label className="form-label">任务备注<textarea placeholder="可选：填写本次广播说明" /></label>
          <div className="precheck-box"><span>✓</span><div><b>预检通过</b><p>{onlineDevices} 台可执行，{selectedDevices - onlineDevices} 台离线将被跳过，当前无优先级冲突。</p></div></div>
          <button className="button button-primary full-button" disabled={!selectedZones.length} onClick={() => setConfirm(true)}>开始广播</button>
        </section>
      </div>

      {confirm && <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirm(false)}>
        <div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(e) => e.stopPropagation()}>
          <button className="modal-close" onClick={() => setConfirm(false)}>×</button>
          <div className="confirm-icon">◉</div>
          <h2 id="confirm-title">确认开始实时广播？</h2>
          <p>广播将立即下发至所选分区。开始后可在任务中心查看每台设备的执行结果。</p>
          <div className="confirm-facts"><div><span>广播内容</span><b>校园安全提示音.mp3</b></div><div><span>目标范围</span><b>{selectedZones.join("、")}</b></div><div><span>预计覆盖</span><b>{onlineDevices} 台在线设备</b></div><div><span>优先级 / 音量</span><b>P1 高 / 75%</b></div></div>
          <div className="risk-note">高优先级广播可能暂停当前低优先级任务，请确认目标范围无误。</div>
          <div className="modal-actions"><button className="button button-secondary" onClick={() => setConfirm(false)}>取消</button><button className="button button-primary" onClick={() => { setConfirm(false); onStarted(); }}>确认并开始</button></div>
        </div>
      </div>}
    </div>
  );
}

function Resources({ role }: { role: Role }) {
  const [filter, setFilter] = useState("全部状态");
  const visibleDevices = useMemo(() => filter === "全部状态" ? deviceRows : deviceRows.filter((row) => row.status.includes(filter.replace("设备", ""))), [filter]);
  return (
    <div className="page">
      <div className="page-heading split-heading"><div><div className="breadcrumb">资源管理 / 分区与设备</div><h1>分区与设备</h1><p>按组织与分区管理 SIP 终端、能力档案和实时运行状态。</p></div><div className="heading-actions"><button className="button button-secondary">导入设备</button><button className="button button-primary" disabled={role !== "系统管理员"}>＋ 新增设备</button></div></div>
      {role !== "系统管理员" && <div className="permission-notice">当前以广播操作员身份查看：设备与分区为只读，您仍可查看状态、诊断摘要和相关任务。</div>}
      <section className="resource-stats"><div><span>全部设备</span><b>356</b><small>5 个一级分区</small></div><div><span>在线设备</span><b className="green">348</b><small>在线率 97.8%</small></div><div><span>离线设备</span><b className="orange">5</b><small>2 台为重点设备</small></div><div><span>异常设备</span><b className="red">3</b><small>媒体 / 鉴权异常</small></div></section>
      <div className="resource-layout">
        <aside className="zone-tree-panel">
          <div className="tree-heading"><b>分区树</b><button disabled={role !== "系统管理员"}>＋</button></div>
          <label className="search-field compact"><span>⌕</span><input placeholder="搜索分区" /></label>
          <button className="tree-node root active"><span>⌄</span><b>校园广播组织</b><em>356</em></button>
          {zones.map((zone, index) => <button className="tree-node child" key={zone.name}><span>{index < 2 ? "⌄" : "›"}</span><b>{zone.name}</b><em>{zone.device}</em></button>)}
        </aside>
        <section className="panel device-panel">
          <div className="table-toolbar"><div className="tabs"><button className="active">设备列表</button><button>SIP 账号</button><button>能力档案</button></div><div className="toolbar-actions"><label className="search-field compact"><span>⌕</span><input placeholder="搜索名称、SIP ID 或 IP" /></label><select value={filter} onChange={(e) => setFilter(e.target.value)}><option>全部状态</option><option>在线设备</option><option>离线设备</option><option>异常设备</option></select><button className="icon-button">☷</button></div></div>
          <div className="table-scroll"><table className="data-table"><thead><tr><th><input type="checkbox" aria-label="全选" /></th><th>设备名称</th><th>类型</th><th>所属分区</th><th>IP 地址</th><th>状态</th><th>最近通信</th><th>操作</th></tr></thead><tbody>{visibleDevices.map((row) => <tr key={row.id}><td><input type="checkbox" aria-label={`选择 ${row.name}`} /></td><td><b>{row.name}</b><small>{row.id}</small></td><td>{row.type}</td><td>{row.zone}</td><td className="mono">{row.ip}</td><td><Status tone={row.status === "在线空闲" || row.status === "播放中" ? "success" : row.status === "离线" ? "neutral" : "danger"}>{row.status}</Status></td><td>{row.last}</td><td><button className="link-action">查看</button><button className="more-action">···</button></td></tr>)}</tbody></table></div>
          <div className="pagination"><span>共 356 台设备</span><div><button disabled>‹</button><button className="active">1</button><button>2</button><button>3</button><span>…</span><button>36</button><button>›</button></div></div>
        </section>
      </div>
    </div>
  );
}

function Tasks() {
  const [tab, setTab] = useState("全部任务");
  return <div className="page"><div className="page-heading split-heading"><div><div className="breadcrumb">广播中心 / 任务中心</div><h1>任务中心</h1><p>统一查看广播队列、执行进度、设备级结果和历史记录。</p></div><button className="button button-secondary">导出当前列表</button></div>
    <section className="panel tasks-card"><div className="table-toolbar"><div className="tabs">{["全部任务", "进行中 1", "待执行 6", "异常 2", "已完成"].map((item) => <button key={item} onClick={() => setTab(item)} className={tab === item ? "active" : ""}>{item}</button>)}</div><div className="toolbar-actions"><label className="search-field compact"><span>⌕</span><input placeholder="搜索任务名称或编号" /></label><button className="button button-secondary small-button">筛选</button></div></div>
    <table className="data-table task-table"><thead><tr><th>任务 / 编号</th><th>类型</th><th>目标范围</th><th>设备结果</th><th>状态</th><th>发起时间</th><th>操作</th></tr></thead><tbody>{taskRows.map((row) => <tr key={row.id}><td><b>{row.name}</b><small>{row.id}</small></td><td>{row.type}</td><td>{row.target}</td><td><div className="result-progress"><span><i style={{ width: `${parseInt(row.progress) / parseInt(row.progress.split("/")[1]) * 100}%` }} /></span><b>{row.progress}</b></div></td><td><Status tone={row.status === "播放中" || row.status === "成功" ? "success" : "warning"}>{row.status}</Status></td><td>08-10 {row.time}</td><td><button className="link-action">详情</button></td></tr>)}</tbody></table></section>
    <div className="task-insight-grid"><section className="panel"><span className="section-kicker">执行质量</span><h2>今日任务结果</h2><div className="donut-row"><div className="donut"><span>98.4%<small>成功率</small></span></div><div className="legend-list"><div><i className="green-bg" />成功确认<b>3,426</b></div><div><i className="orange-bg" />推定完成<b>41</b></div><div><i className="red-bg" />失败 / 未知<b>16</b></div></div></div></section><section className="panel"><span className="section-kicker">失败原因</span><h2>需要关注的问题</h2><div className="reason-bars"><div><span>终端离线</span><i><b style={{ width: "78%" }} /></i><em>8</em></div><div><span>媒体不可达</span><i><b style={{ width: "48%" }} /></i><em>5</em></div><div><span>能力不兼容</span><i><b style={{ width: "28%" }} /></i><em>3</em></div></div></section></div>
  </div>;
}

function Permissions({ role }: { role: Role }) {
  return <div className="page"><div className="page-heading split-heading"><div><div className="breadcrumb">系统管理 / 用户与权限</div><h1>用户与权限</h1><p>首版采用系统管理员、广播操作员两个固定角色，权限边界清晰可审计。</p></div><button className="button button-primary" disabled={role !== "系统管理员"}>＋ 新增用户</button></div>
    <div className="role-summary-grid"><article className="role-card admin"><div className="role-card-top"><span className="avatar role-avatar">管</span><Status tone="info">系统内置</Status></div><h2>系统管理员</h2><p>负责平台配置、设备运维、用户权限、安全与审计，可配置是否参与广播业务。</p><div><span>当前用户</span><b>3 人</b></div></article><article className="role-card operator"><div className="role-card-top"><span className="avatar role-avatar">播</span><Status tone="success">系统内置</Status></div><h2>广播操作员</h2><p>执行日常与应急广播、计划、内容和告警处理，仅访问被授权分区的数据。</p><div><span>当前用户</span><b>12 人</b></div></article><article className="role-note"><span>i</span><div><b>为什么首版固定两个角色？</b><p>降低授权复杂度，便于试点阶段验证业务边界。自定义角色计划在 V1.1 提供。</p></div></article></div>
    <section className="panel permission-matrix"><div className="panel-title-row"><div><span className="section-kicker">权限基线</span><h2>预置角色权限矩阵</h2></div><button className="text-button">查看权限说明</button></div><table className="data-table"><thead><tr><th>能力</th><th><span className="role-head admin-head">管</span>系统管理员</th><th><span className="role-head operator-head">播</span>广播操作员</th></tr></thead><tbody>{permissionRows.map((row) => <tr key={row[0]}><td><b>{row[0]}</b></td><td>{row[1]}</td><td>{row[2]}</td></tr>)}</tbody></table></section>
    <section className="panel user-list"><div className="panel-title-row"><div><span className="section-kicker">账号</span><h2>最近活跃用户</h2></div><button className="text-button">查看全部用户</button></div><div className="user-rows"><div><span className="avatar">林</span><span><b>林值班员</b><small>lin.operator · 广播操作员</small></span><Status tone="success">在线</Status><em>刚刚</em></div><div><span className="avatar blue-avatar">周</span><span><b>周系统管理员</b><small>zhou.admin · 系统管理员</small></span><Status tone="success">在线</Status><em>6 分钟前</em></div><div><span className="avatar violet-avatar">陈</span><span><b>陈广播员</b><small>chen.operator · 广播操作员</small></span><Status>离线</Status><em>昨天 18:32</em></div></div></section>
  </div>;
}

function PlaceholderPage({ page }: { page: PageKey }) {
  const content: Partial<Record<PageKey, { crumb: string; title: string; desc: string; stats: string[]; cards: Array<[string, string, string]> }>> = {
    schedule: { crumb: "广播中心 / 定时计划", title: "定时计划", desc: "创建一次性或周期广播，提前发现目标、时间和优先级冲突。", stats: ["18 今日计划", "6 待执行", "1 存在冲突"], cards: [["14:00", "消防演练提示", "行政办公区 · P1 高"], ["17:30", "闭馆提醒", "体育场馆 · P2 普通"], ["18:00", "晚间校园音乐", "学生宿舍区 · P2 普通"]] },
    emergency: { crumb: "应急广播 / 预案库", title: "应急预案", desc: "将高风险广播固化为受控、可演练、可追溯的快捷流程。", stats: ["8 可用预案", "2 本月演练", "0 待复核"], cards: [["P0", "火灾疏散广播", "全区 · 强制音量 90%"], ["P0", "极端天气预警", "室外公共区 · 循环播放"], ["P1", "人员寻呼协助", "可选分区 · 需二次确认"]] },
    content: { crumb: "内容中心 / 音频库", title: "内容中心", desc: "管理音频、标签、版本与引用关系，保障广播内容安全可用。", stats: ["126 音频文件", "4 转码中", "18 被计划引用"], cards: [["MP3", "校园安全提示音", "00:28 · 安全提示"], ["MP3", "午间校园音乐", "05:58 · 日常音乐"], ["WAV", "临时通知前奏", "00:06 · 提示音"]] },
    alarms: { crumb: "监控告警 / 告警中心", title: "监控告警", desc: "聚合设备、任务和服务异常，形成确认、分派、处理和关闭闭环。", stats: ["4 待处理", "2 重要告警", "18 分钟平均处理"], cards: [["重要", "中心广场东侧音柱媒体连接失败", "持续 8 分钟 · 待确认"], ["重要", "宿舍 D3 东侧音柱离线", "持续 12 分钟 · 处理中"], ["一般", "教学楼 A1 二层任务部分失败", "2 台未确认 · 待分派"]] },
    reports: { crumb: "报表审计 / 广播报表", title: "报表与审计", desc: "统一统计广播覆盖、设备健康和高风险操作，支持按权限导出。", stats: ["98.4% 今日成功率", "97.8% 设备在线率", "7 高风险操作"], cards: [["广播质量", "任务成功率趋势", "过去 7 日平均 98.1%"], ["设备健康", "重点设备可用率", "过去 30 日平均 99.2%"], ["安全审计", "高风险操作记录", "全部已完成审计"]] },
    system: { crumb: "系统管理 / 系统配置", title: "系统配置", desc: "集中维护 SIP、媒体、时间、存储和第三方调用规则。", stats: ["SIP 服务正常", "媒体节点 3 / 3", "存储使用 42%"], cards: [["SIP", "基础配置", "域、端口、鉴权与路由策略"], ["媒体", "媒体与转码", "Codec、RTP、组播与节点配置"], ["时间", "时间与日历", "Asia/Shanghai · NTP 正常"]] },
  };
  const data = content[page] ?? content.schedule!;
  return <div className="page"><div className="page-heading split-heading"><div><div className="breadcrumb">{data.crumb}</div><h1>{data.title}</h1><p>{data.desc}</p></div><button className="button button-primary">＋ 新建</button></div><section className="placeholder-stats">{data.stats.map((item, index) => { const [value, ...rest] = item.split(" "); return <div key={item}><span className={`placeholder-icon p${index}`}>{index === 0 ? "◉" : index === 1 ? "⌘" : "△"}</span><b>{value}</b><small>{rest.join(" ")}</small></div>; })}</section><section className="panel placeholder-panel"><div className="panel-title-row"><div><span className="section-kicker">工作列表</span><h2>需要关注</h2></div><button className="text-button">查看全部</button></div><div className="placeholder-list">{data.cards.map((card, index) => <button key={card[1]}><span className={`list-mark m${index}`}>{card[0]}</span><span><b>{card[1]}</b><small>{card[2]}</small></span><em>查看详情 →</em></button>)}</div></section></div>;
}

export default function Home() {
  const [page, setPage] = useState<PageKey>("overview");
  const [role, setRole] = useState<Role>("广播操作员");
  const [roleMenu, setRoleMenu] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [collapsed, setCollapsed] = useState(false);

  const pageLabel = navGroups.flatMap(g => g.items).find(item => item.key === page)?.label ?? "运行总览";
  const go = (next: PageKey) => { setPage(next); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 3600); };

  return (
    <main className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><i /><i /><i /></span><span><b>声域</b><small>SIP BROADCAST</small></span></div>
        <nav aria-label="主导航">
          {navGroups.map((group) => <div className="nav-group" key={group.label}><div className="nav-group-label">{group.label}</div>{group.items.map((item) => <button key={item.key} className={page === item.key ? "active" : ""} onClick={() => go(item.key)} title={collapsed ? item.label : undefined}><Icon>{item.icon}</Icon><span>{item.label}</span>{item.badge && <em>{item.badge}</em>}</button>)}</div>)}
        </nav>
        <div className="system-health"><div><i /><span><b>系统运行正常</b><small>所有核心服务可用</small></span></div><button>›</button></div>
        <button className="collapse-button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}>{collapsed ? "›" : "‹"}</button>
      </aside>
      <section className="main-area">
        <header className="topbar">
          <div className="topbar-context"><b>{pageLabel}</b><span>校园广播组织</span></div>
          <div className="topbar-right"><TopActions onEmergency={() => setEmergencyOpen(true)} /><div className="profile-wrap"><button className="profile" onClick={() => setRoleMenu(!roleMenu)} aria-expanded={roleMenu}><span className="avatar">{role === "系统管理员" ? "周" : "林"}</span><span><b>{role === "系统管理员" ? "周系统管理员" : "林值班员"}</b><small>{role}</small></span><em>⌄</em></button>{roleMenu && <div className="role-menu"><span>原型角色视角</span><button className={role === "广播操作员" ? "active" : ""} onClick={() => { setRole("广播操作员"); setRoleMenu(false); }}><i className="avatar mini">林</i><span><b>林值班员</b><small>广播操作员</small></span>{role === "广播操作员" && <em>✓</em>}</button><button className={role === "系统管理员" ? "active" : ""} onClick={() => { setRole("系统管理员"); setRoleMenu(false); }}><i className="avatar mini blue-avatar">周</i><span><b>周系统管理员</b><small>系统管理员</small></span>{role === "系统管理员" && <em>✓</em>}</button></div>}</div></div>
        </header>

        {page === "overview" && <Overview go={go} onEmergency={() => setEmergencyOpen(true)} />}
        {page === "realtime" && <Realtime onStarted={() => { notify("广播任务已创建，正在向 126 台在线设备下发"); go("tasks"); }} />}
        {page === "resources" && <Resources role={role} />}
        {page === "tasks" && <Tasks />}
        {page === "permissions" && <Permissions role={role} />}
        {!(["overview", "realtime", "resources", "tasks", "permissions"] as PageKey[]).includes(page) && <PlaceholderPage page={page} />}
      </section>

      {emergencyOpen && <div className="modal-backdrop" onMouseDown={() => setEmergencyOpen(false)}><div className="modal emergency-modal" onMouseDown={(e) => e.stopPropagation()}><button className="modal-close" onClick={() => setEmergencyOpen(false)}>×</button><div className="emergency-symbol">⚡</div><h2>选择应急预案</h2><p>应急广播具有最高执行优先级，触发前请确认事件和目标范围。</p><div className="emergency-options"><button onClick={() => { setEmergencyOpen(false); notify("已进入火灾疏散广播确认流程"); }}><span>P0</span><div><b>火灾疏散广播</b><small>全区 · 强制音量 90% · 循环播放</small></div><em>›</em></button><button><span>P0</span><div><b>极端天气预警</b><small>室外公共区 · 强制音量 85%</small></div><em>›</em></button><button><span className="p1">P1</span><div><b>人员寻呼协助</b><small>自选分区 · 需二次确认</small></div><em>›</em></button></div><button className="text-button modal-library" onClick={() => { setEmergencyOpen(false); go("emergency"); }}>进入完整预案库 →</button></div></div>}
      {toast && <div className="toast"><span>✓</span><div><b>操作成功</b><p>{toast}</p></div><button onClick={() => setToast("")}>×</button></div>}
    </main>
  );
}
