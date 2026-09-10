import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function clone(value) {
  return structuredClone(value);
}

export class MediaStore {
  constructor({ metadataFile, mediaDirectory, freeswitchPrefix }) {
    this.metadataFile = metadataFile;
    this.mediaDirectory = mediaDirectory;
    // 音频文件在 FreeSWITCH 侧的可访问路径。容器部署时是 Linux 绝对路径，
    // Windows 便携部署时可指向便携目录，因此允许通过环境变量覆盖。
    this.freeswitchPrefix = (freeswitchPrefix ?? "/var/lib/freeswitch/storage/media").replace(/\/+$/, "");
    this.state = { files: [], playlists: [] };
    this.load();
  }

  load() {
    mkdirSync(dirname(this.metadataFile), { recursive: true });
    mkdirSync(this.mediaDirectory, { recursive: true });
    if (!existsSync(this.metadataFile)) return;
    const parsed = JSON.parse(readFileSync(this.metadataFile, "utf8"));
    this.state.files = Array.isArray(parsed.files) ? parsed.files : [];
    this.state.playlists = Array.isArray(parsed.playlists) ? parsed.playlists : [];
  }

  persist() {
    const temporaryPath = `${this.metadataFile}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2));
    renameSync(temporaryPath, this.metadataFile);
  }

  listFiles() {
    return this.state.files.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  getFile(id) {
    const file = this.state.files.find((item) => item.id === id);
    return file ? clone(file) : null;
  }

  resolveFile(id) {
    const file = this.getFile(id);
    if (!file) throw problem("audio file not found", 404);
    return { file, path: join(this.mediaDirectory, file.storageName) };
  }

  createFile({ originalName, buffer }) {
    const safeName = basename(String(originalName ?? "")).trim();
    const extension = extname(safeName).toLowerCase();
    if (!safeName || safeName.length > 180) throw problem("file name must contain 1-180 characters");
    if (![".wav", ".mp3"].includes(extension)) throw problem("only WAV and MP3 files are supported", 415);
    if (!buffer.length) throw problem("audio file is empty");

    const isWav = buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE";
    const isMp3 = buffer.length >= 3 && (buffer.subarray(0, 3).toString("ascii") === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0));
    if ((extension === ".wav" && !isWav) || (extension === ".mp3" && !isMp3)) {
      throw problem(`file content is not a valid ${extension.slice(1).toUpperCase()} stream`, 415);
    }

    const id = randomUUID();
    const storageName = `${id}${extension}`;
    const now = new Date().toISOString();
    const file = {
      id,
      name: safeName.slice(0, -extension.length),
      originalName: safeName,
      format: extension.slice(1).toUpperCase(),
      contentType: extension === ".wav" ? "audio/wav" : "audio/mpeg",
      size: buffer.length,
      storageName,
      freeswitchPath: `${this.freeswitchPrefix}/${storageName}`,
      createdAt: now,
    };
    writeFileSync(join(this.mediaDirectory, storageName), buffer, { flag: "wx" });
    this.state.files.push(file);
    this.persist();
    return clone(file);
  }

  listPlaylists() {
    return this.state.playlists.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((playlist) => {
      const result = clone(playlist);
      delete result.description;
      return { ...result, files: playlist.fileIds.map((id) => this.getFile(id)).filter(Boolean) };
    });
  }

  getPlaylist(id) {
    return this.listPlaylists().find((playlist) => playlist.id === id) ?? null;
  }

  createPlaylist(input) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 80) throw problem("playlist name must contain 1-80 characters");
    if (this.state.playlists.some((item) => item.name.toLowerCase() === name.toLowerCase())) throw problem("playlist name already exists", 409);
    const now = new Date().toISOString();
    const playlist = { id: randomUUID(), name, fileIds: [], createdAt: now, updatedAt: now };
    this.state.playlists.push(playlist);
    this.persist();
    return { ...clone(playlist), files: [] };
  }

  renamePlaylist(playlistId, input) {
    const playlist = this.state.playlists.find((item) => item.id === playlistId);
    if (!playlist) throw problem("playlist not found", 404);
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 80) throw problem("playlist name must contain 1-80 characters");
    if (this.state.playlists.some((item) => item.id !== playlistId && item.name.toLowerCase() === name.toLowerCase())) throw problem("playlist name already exists", 409);
    playlist.name = name;
    delete playlist.description;
    playlist.updatedAt = new Date().toISOString();
    this.persist();
    return this.listPlaylists().find((item) => item.id === playlistId);
  }

  addToPlaylist(playlistId, audioFileId) {
    const playlist = this.state.playlists.find((item) => item.id === playlistId);
    if (!playlist) throw problem("playlist not found", 404);
    if (!this.state.files.some((item) => item.id === audioFileId)) throw problem("audio file not found", 404);
    if (!playlist.fileIds.includes(audioFileId)) playlist.fileIds.push(audioFileId);
    playlist.updatedAt = new Date().toISOString();
    this.persist();
    return this.listPlaylists().find((item) => item.id === playlistId);
  }

  removeFromPlaylist(playlistId, audioFileId) {
    const playlist = this.state.playlists.find((item) => item.id === playlistId);
    if (!playlist) throw problem("playlist not found", 404);
    playlist.fileIds = playlist.fileIds.filter((id) => id !== audioFileId);
    playlist.updatedAt = new Date().toISOString();
    this.persist();
    return this.listPlaylists().find((item) => item.id === playlistId);
  }
}
