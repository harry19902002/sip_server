// 播放内容展开：把「文件 / 播放列表」多选项解析成 FreeSWITCH 可播放的音频路径序列。
//
// 实时广播与定时计划共用这段逻辑：
//   - 实时广播：在 POST /api/v1/broadcasts 里展开 input.sources
//   - 定时计划：建立计划时持久化 sourceItems，触发时再展开成音频
//
// 抽出来的原因：随机播放必须在展开后打乱顺序，两处若各写一份极易不一致。

import { randomInt } from "node:crypto";

// 播放模式：ONCE 单次、LOOP 循环、SHUFFLE 随机（顺序在上游打乱）。
export const PLAY_MODES = ["ONCE", "LOOP", "SHUFFLE"];
export const MAX_MEDIA_FILES = 100;
export const MAX_SOURCES = 50;

export function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// Fisher-Yates 洗牌；返回新数组，不修改入参。
export function shufflePaths(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export function normalizePlayMode(value) {
  const mode = String(value ?? "").toUpperCase();
  return PLAY_MODES.includes(mode) ? mode : "ONCE";
}

/**
 * 展开音源为音频路径序列。
 * @returns {{ paths: string[], sourceItems: Array, sourceType: string, sourceId: string|null, sourceName: string }}
 */
export function expandSources({ sources, playlistId, mediaFileId, media }) {
  const paths = [];
  const sourceItems = [];

  if (Array.isArray(sources) && sources.length) {
    if (sources.length > MAX_SOURCES) throw problem(`播放内容最多选择 ${MAX_SOURCES} 项`);
    for (const source of sources) {
      const id = String(source?.id ?? "");
      if (source?.type === "FILE") {
        const file = media.getFile(id);
        if (!file) throw problem("所选音频文件不存在", 404);
        paths.push(file.freeswitchPath);
        sourceItems.push({ type: "FILE", id: file.id, name: file.originalName, fileCount: 1 });
      } else if (source?.type === "PLAYLIST") {
        const playlist = media.getPlaylist(id);
        if (!playlist) throw problem("所选播放列表不存在", 404);
        if (!playlist.files.length) throw problem(`播放列表“${playlist.name}”中没有音频文件`);
        paths.push(...playlist.files.map((file) => file.freeswitchPath));
        sourceItems.push({ type: "PLAYLIST", id: playlist.id, name: playlist.name, fileCount: playlist.files.length });
      } else {
        throw problem("播放内容类型不正确");
      }
    }
  } else if (playlistId) {
    const playlist = media.getPlaylist(String(playlistId));
    if (!playlist) throw problem("播放列表不存在", 404);
    if (!playlist.files.length) throw problem("播放列表中没有音频文件");
    paths.push(...playlist.files.map((file) => file.freeswitchPath));
    sourceItems.push({ type: "PLAYLIST", id: playlist.id, name: playlist.name, fileCount: playlist.files.length });
  } else if (mediaFileId) {
    // 兼容旧的单文件字段
    const file = media.getFile(String(mediaFileId));
    if (!file) throw problem("音频文件不存在", 404);
    paths.push(file.freeswitchPath);
    sourceItems.push({ type: "FILE", id: file.id, name: file.originalName, fileCount: 1 });
  }

  if (!paths.length) throw problem("请至少选择一项播放内容");
  if (paths.length > MAX_MEDIA_FILES) throw problem(`展开播放列表后音频总数不能超过 ${MAX_MEDIA_FILES} 个`);

  return {
    paths,
    sourceItems,
    sourceType: sourceItems.length > 1 ? "MIXED" : sourceItems[0].type,
    sourceId: sourceItems.length === 1 ? sourceItems[0].id : null,
    sourceName: sourceItems.map((source) => source.name).join("、"),
  };
}

/**
 * 由已展开的音频路径构造播放串，并按模式决定是否打乱。
 * 长度为 1 时直接返回该路径（FreeSWITCH 对 file_string:// 单个文件也接受，但直给更清晰）。
 */
export function buildAudio(paths, playMode) {
  const ordered = playMode === "SHUFFLE" ? shufflePaths(paths) : paths;
  return ordered.length === 1 ? ordered[0] : `file_string://${ordered.join("!")}`;
}
