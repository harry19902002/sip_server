"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

type Source = { type: "FILE" | "PLAYLIST"; id: string };
type Zone = { id: string; name: string; terminalIds: string[] };
type Media = { id: string; originalName: string };
type Playlist = { id: string; name: string; files: Media[] };
type Preset = {
  id: string; name: string; sipNumber: string; zoneIds: string[]; sources: Source[];
  volume: number; playMode: "ONCE" | "LOOP" | "SHUFFLE"; zones: Zone[];
  sourceItems: Array<Source & { name: string; fileCount: number }>;
  error: string | null; active: boolean; trigger: "WEB" | "SIP";
  broadcast: { state: string; targets: Array<{ answeredAt: string | null; state: string }> } | null;
};
type Draft = Pick<Preset, "name" | "zoneIds" | "sources" | "volume" | "playMode">;
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const modes = { ONCE: "单次播放", LOOP: "循环播放", SHUFFLE: "随机播放" };
const initialDraft: Draft = { name: "", zoneIds: [], sources: [], volume: 75, playMode: "ONCE" };

export default function PresetBroadcasts({ request, notify }: { request: Request; notify: (message: string) => void }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [files, setFiles] = useState<Media[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Preset | null>(null);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Preset | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [presetData, zoneData, fileData, playlistData] = await Promise.all([
        request<{ items: Preset[] }>("/presets"), request<{ items: Zone[] }>("/zones"),
        request<{ items: Media[] }>("/media/files"), request<{ items: Playlist[] }>("/media/playlists"),
      ]);
      setPresets(presetData.items); setZones(zoneData.items); setFiles(fileData.items); setPlaylists(playlistData.items);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "预设广播加载失败"); }
    finally { setLoading(false); }
  }, [request]);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);
  const openEditor = (preset: Preset | null = null) => {
    setEditing(preset); setDraft(preset ? { name: preset.name, zoneIds: [...preset.zoneIds], sources: [...preset.sources], volume: preset.volume, playMode: preset.playMode } : initialDraft);
    setFormError(""); setEditorOpen(true);
  };
  const toggleSource = (source: Source) => setDraft((current) => ({ ...current, sources: current.sources.some((item) => item.type === source.type && item.id === source.id)
    ? current.sources.filter((item) => !(item.type === source.type && item.id === source.id)) : [...current.sources, source] }));
  const sourceName = (source: Source) => source.type === "FILE" ? files.find((file) => file.id === source.id)?.originalName : playlists.find((playlist) => playlist.id === source.id)?.name;
  const moveSource = (index: number, direction: number) => setDraft((current) => {
    const sources = [...current.sources]; [sources[index], sources[index + direction]] = [sources[index + direction], sources[index]];
    return { ...current, sources };
  });
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setFormError("");
    try {
      await request(`/presets${editing ? `/${editing.id}` : ""}`, { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      setEditorOpen(false); await refresh(); notify(editing ? "预设广播已保存" : "预设广播已创建，专属呼叫号码已分配");
    } catch (failure) { setFormError(failure instanceof Error ? failure.message : "保存失败"); }
    finally { setSaving(false); }
  };
  const run = async (preset: Preset, action: "play" | "stop" | "delete") => {
    setBusyIds((current) => [...current, preset.id]); setError("");
    try {
      await request(`/presets/${preset.id}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST" });
      if (action === "delete") setDeleting(null);
      await refresh(); notify(action === "play" ? "预设广播已开始下发" : action === "stop" ? "预设广播已停止" : "预设广播已删除");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setBusyIds((current) => current.filter((id) => id !== preset.id)); }
  };
  const visible = presets.filter((preset) => [preset.name, preset.sipNumber, ...preset.zones.map((zone) => zone.name)].join(" ").toLowerCase().includes(search.trim().toLowerCase()));

  return <div className="page presets-page">
    <div className="page-heading split-heading"><div><div className="breadcrumb">广播中心 / 预设广播</div><h1>预设广播</h1><p>提前保存分区和播放内容，一键播放，或拨打专属 SIP 号码启动广播。</p></div><div className="heading-actions"><button className="button button-secondary" disabled={loading} onClick={() => { setError(""); void refresh(); }}>↻ 刷新</button><button className="button button-primary" disabled={loading} onClick={() => openEditor()}>＋ 新建预设</button></div></div>
    {error && <div className="media-error" role="alert"><span>!</span>{error}<button aria-label="关闭提示" onClick={() => setError("")}>×</button></div>}
    <section className="preset-explainer"><span className="preset-phone-icon">☎</span><div><b>拨号即播，挂断即停</b><p>使用已注册的 SIP 账号拨打预设号码。通话建立后，所选内容会播放到目标分区；挂断主叫或点击停止即可结束。内容播完后自动结束。</p></div></section>
    <div className="preset-toolbar"><div><b>{presets.length}</b> 个预设 <span>·</span> <b>{presets.filter((preset) => preset.active).length}</b> 个正在运行</div><label className="search-field compact"><span>⌕</span><input aria-label="搜索预设广播" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、号码或分区" /></label></div>
    {loading ? <div className="panel schedule-empty">正在加载预设广播…</div> : visible.length === 0 ? <div className="panel terminal-empty"><span>▣</span><h3>{presets.length ? "没有匹配的预设" : "还没有预设广播"}</h3><p>{presets.length ? "试试其他名称或 SIP 号码。" : "保存常用的广播分区和内容，下次直接播放。"}</p><button className="button button-primary" onClick={() => presets.length ? setSearch("") : openEditor()}>{presets.length ? "清除搜索" : "创建第一个预设"}</button></div> : <section className="preset-grid">{visible.map((preset) => {
      const busy = busyIds.includes(preset.id);
      const answered = preset.broadcast?.targets.filter((target) => target.answeredAt && !["SUCCEEDED", "FAILED", "CANCELED"].includes(target.state)).length ?? 0;
      const terminalCount = new Set(preset.zones.flatMap((zone) => zone.terminalIds)).size;
      const stateLabel = preset.active ? answered ? "播放中" : "呼叫中" : preset.error ? "配置需更新" : "待播放";
      return <article className={`panel preset-card ${preset.active ? "is-playing" : ""}`} key={preset.id}>
        <div className="preset-card-heading"><span className="preset-card-icon">▣</span><div><h2>{preset.name}</h2><span className={`status status-${preset.active ? "info" : preset.error ? "warning" : "neutral"}`}><i />{stateLabel}</span></div></div>
        <div className="preset-number"><span>SIP 广播呼叫号码</span><strong>{preset.sipNumber}</strong><small>{preset.active ? preset.trigger === "SIP" ? "由 SIP 呼叫发起 · 挂断主叫即可停止" : "由管理页面发起" : "拨打此号码即可播放预设内容"}</small></div>
        <dl className="preset-details"><div><dt>目标分区</dt><dd>{preset.zones.map((zone) => zone.name).join("、") || "分区已删除"}<small>{terminalCount} 台配置终端{preset.active ? ` · ${answered} 台正在接听` : ""}</small></dd></div><div><dt>播放内容</dt><dd>{preset.sourceItems.map((source) => source.name).join(" → ") || "内容不可用"}</dd></div><div><dt>播放设置</dt><dd>{modes[preset.playMode]} <span>·</span> 音量 {preset.volume}%</dd></div></dl>
        {preset.error && <p className="preset-warning">{preset.error}</p>}
        {!preset.active && preset.broadcast?.state === "FAILED" && <p className="preset-warning">最近广播失败，请在任务中心查看终端响应。</p>}
        <div className="preset-card-actions"><button className={`button ${preset.active ? "button-danger-ghost" : "button-primary"}`} disabled={busy || (!preset.active && Boolean(preset.error))} onClick={() => void run(preset, preset.active ? "stop" : "play")}>{busy ? "处理中…" : preset.active ? "■ 停止广播" : "▶ 播放广播"}</button><div><button className="link-action" disabled={preset.active || busy} onClick={() => openEditor(preset)}>编辑</button><button className="link-action danger-link" disabled={preset.active || busy} onClick={() => { setError(""); setDeleting(preset); }}>删除</button></div></div>
      </article>;
    })}</section>}
    {editorOpen && <div className="modal-backdrop"><form className="modal schedule-editor-modal preset-editor" role="dialog" aria-modal="true" aria-labelledby="preset-editor-title" onSubmit={(event) => void save(event)}><button type="button" className="modal-close" aria-label="关闭编辑器" disabled={saving} onClick={() => setEditorOpen(false)}>×</button><div className="schedule-modal-heading"><span>▣</span><div><span className="section-kicker">常用广播</span><h2 id="preset-editor-title">{editing ? "编辑预设广播" : "新建预设广播"}</h2><p>{editing ? `SIP 呼叫号码 ${editing.sipNumber}，保存后继续使用此号码。` : "保存后自动分配一个专属 SIP 广播呼叫号码。"}</p></div></div>
      {formError && <div className="media-error" role="alert">{formError}</div>}
      <div className="schedule-form"><label className="wide"><span>预设名称 <em>*</em></span><input required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：全校安全提醒" /></label>
        <fieldset className="wide preset-fieldset"><legend>目标分区 *</legend>{!zones.length && <p>请先在“分区管理”创建广播分区。</p>}<div className="schedule-targets">{zones.map((zone) => <button type="button" aria-pressed={draft.zoneIds.includes(zone.id)} key={zone.id} className={draft.zoneIds.includes(zone.id) ? "selected" : ""} onClick={() => setDraft((current) => ({ ...current, zoneIds: current.zoneIds.includes(zone.id) ? current.zoneIds.filter((id) => id !== zone.id) : [...current.zoneIds, zone.id] }))}><i>{draft.zoneIds.includes(zone.id) ? "✓" : "+"}</i><span><b>{zone.name}</b><small>{zone.terminalIds.length} 台配置终端</small></span></button>)}</div></fieldset>
        <fieldset className="wide preset-fieldset"><legend>播放内容 *</legend><p>按选中顺序播放，可调整顺序；播放列表会使用执行时的最新内容。</p>{!files.length && !playlists.length && <p>请先在“媒体库”上传音频或创建播放列表。</p>}<div className="preset-source-picker">{files.map((file) => <label key={file.id}><input type="checkbox" checked={draft.sources.some((source) => source.type === "FILE" && source.id === file.id)} onChange={() => toggleSource({ type: "FILE", id: file.id })} /><span>♪ {file.originalName}</span></label>)}{playlists.map((playlist) => <label key={playlist.id}><input type="checkbox" disabled={!playlist.files.length} checked={draft.sources.some((source) => source.type === "PLAYLIST" && source.id === playlist.id)} onChange={() => toggleSource({ type: "PLAYLIST", id: playlist.id })} /><span>≡ {playlist.name} <small>{playlist.files.length} 个音频</small></span></label>)}</div>
          {draft.sources.length > 0 && <ol className="preset-source-order">{draft.sources.map((source, index) => <li key={`${source.type}:${source.id}`}><span>{index + 1}. {sourceName(source) ?? "内容已删除"}</span><div><button type="button" aria-label={`上移${sourceName(source) ?? "内容"}`} disabled={index === 0} onClick={() => moveSource(index, -1)}>↑</button><button type="button" aria-label={`下移${sourceName(source) ?? "内容"}`} disabled={index === draft.sources.length - 1} onClick={() => moveSource(index, 1)}>↓</button><button type="button" aria-label={`移除${sourceName(source) ?? "内容"}`} onClick={() => toggleSource(source)}>×</button></div></li>)}</ol>}
        </fieldset>
        <label><span>播放模式</span><select value={draft.playMode} onChange={(event) => setDraft({ ...draft, playMode: event.target.value as Draft["playMode"] })}>{Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="schedule-volume"><span>播放音量 <b>{draft.volume}%</b></span><input type="range" min="0" max="100" value={draft.volume} onChange={(event) => setDraft({ ...draft, volume: Number(event.target.value) })} /></label>
      </div><div className="schedule-form-note">单次和随机播放在内容播完后结束；循环播放会持续到点击停止或 SIP 主叫挂断。</div><div className="modal-actions"><button type="button" className="button button-secondary" disabled={saving} onClick={() => setEditorOpen(false)}>取消</button><button type="submit" className="button button-primary" disabled={saving || !draft.name.trim() || !draft.zoneIds.length || !draft.sources.length}>{saving ? "正在保存…" : "保存预设"}</button></div>
    </form></div>}
    {deleting && <div className="modal-backdrop"><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-preset-title"><h2 id="delete-preset-title">删除“{deleting.name}”？</h2><p>删除后号码 {deleting.sipNumber} 将失效，已有广播任务记录会保留。</p>{error && <div className="media-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button button-secondary" disabled={busyIds.includes(deleting.id)} onClick={() => setDeleting(null)}>取消</button><button className="button button-danger-solid" disabled={busyIds.includes(deleting.id)} onClick={() => void run(deleting, "delete")}>确认删除</button></div></div></div>}
  </div>;
}
