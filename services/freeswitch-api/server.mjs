import { createServer } from "node:http";
import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { EslClient, EslEventSubscriber } from "./lib/esl-client.mjs";
import { BroadcastStore } from "./lib/broadcast-store.mjs";
import { BroadcastService } from "./lib/broadcast-service.mjs";
import { MediaStore } from "./lib/media-store.mjs";
import { terminalRegistry } from "./lib/terminal-registry.mjs";
import { sipAccountRegistry } from "./lib/sip-account-registry.mjs";
import { SipAccountStore } from "./lib/sip-account-store.mjs";
import { TerminalMetadataStore } from "./lib/terminal-metadata-store.mjs";
import { ZoneStore } from "./lib/zone-store.mjs";
import { ScheduleStore } from "./lib/schedule-store.mjs";
import { ScheduleService } from "./lib/schedule-service.mjs";
import { SystemStore } from "./lib/system-store.mjs";

const config = {
  port: Number(process.env.PORT ?? 3001),
  apiKey: process.env.API_KEY ?? "",
  dataFile: process.env.BROADCAST_DATA_FILE ?? "/data/broadcasts.json",
  mediaDataFile: process.env.MEDIA_DATA_FILE ?? "/data/media.json",
  mediaDirectory: process.env.MEDIA_DIRECTORY ?? "/media",
  // 音频在 FreeSWITCH 侧的可访问路径前缀；Windows 便携部署时可覆盖
  mediaFreeswitchPrefix: process.env.MEDIA_FREESWITCH_PREFIX ?? "/var/lib/freeswitch/storage/media",
  // 允许广播的音频根目录，逗号分隔；未设置时使用内置默认值
  audioRoots: (process.env.AUDIO_ROOTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  sipDirectory: process.env.SIP_DIRECTORY ?? "/sip-directory",
  sipPort: Number(process.env.SIP_PORT ?? 5060),
  sipServerHost: process.env.SIP_SERVER_HOST ?? "127.0.0.1",
  terminalMetadataFile: process.env.TERMINAL_METADATA_FILE ?? "/data/terminals.json",
  zoneDataFile: process.env.ZONE_DATA_FILE ?? "/data/zones.json",
  scheduleDataFile: process.env.SCHEDULE_DATA_FILE ?? "/data/schedules.json",
  systemDataFile: process.env.SYSTEM_DATA_FILE ?? "/data/system.json",
  systemAdminUsername: process.env.SYSTEM_ADMIN_USERNAME ?? "admin",
  systemAdminPassword: process.env.SYSTEM_ADMIN_PASSWORD ?? "123456",
  allowBrowserApi: process.env.ALLOW_INSECURE_BROWSER_API === "true",
  domain: process.env.FREESWITCH_DOMAIN ?? "sip.local",
  esl: {
    host: process.env.ESL_HOST ?? "127.0.0.1",
    port: Number(process.env.ESL_PORT ?? 8021),
    password: process.env.ESL_PASSWORD ?? "",
    timeoutMs: Number(process.env.ESL_TIMEOUT_MS ?? 5000),
  },
};

if (!config.apiKey || !config.esl.password) {
  throw new Error("API_KEY and ESL_PASSWORD are required");
}

const esl = new EslClient(config.esl);
const eventSubscriber = new EslEventSubscriber(config.esl);
const store = new BroadcastStore(config.dataFile);
const broadcasts = new BroadcastService({ store, esl, domain: config.domain, audioRoots: config.audioRoots });
const media = new MediaStore({
  metadataFile: config.mediaDataFile,
  mediaDirectory: config.mediaDirectory,
  freeswitchPrefix: config.mediaFreeswitchPrefix,
});
const sipAccounts = new SipAccountStore(config.sipDirectory);
const terminalMetadata = new TerminalMetadataStore(config.terminalMetadataFile);
const zones = new ZoneStore(config.zoneDataFile);
const schedules = new ScheduleService({ store: new ScheduleStore(config.scheduleDataFile), media, zones, broadcasts });
const system = new SystemStore(config.systemDataFile);
system.ensureBootstrapAdmin({ username: config.systemAdminUsername, name: "系统管理员", password: config.systemAdminPassword });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// 局域网部署时，管理页面通过 http://<局域网IP>:3000 打开，
// 而 API 在 <局域网IP>:3001，属于同主机跨端口。浏览器会带上
// Origin: http://<局域网IP>:3000，若白名单只放行回环地址，
// 登录等所有带凭据请求都会被 CORS 拦截（表现为「页面能开、但登录无反应」）。
// 因此除回环地址外，还要放行私有网段与同为私有网段的 Host。
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isPrivateHostname(hostname) {
  const host = String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  // IPv4 私有 / 链路本地网段
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // IPv6 唯一本地地址 / 链路本地
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe80:/.test(host)) return true;
  return false;
}

function browserOrigin(request) {
  const origin = request.headers.origin;
  if (!config.allowBrowserApi || typeof origin !== "string") return null;
  try {
    const url = new URL(origin);
    if (!isPrivateHostname(url.hostname)) return null;
    // 同主机校验：Origin 的主机必须与本次请求到达的主机一致，
    // 避免页面挂在 A 机器却去调用 B 机器的 API。
    const hostHeader = String(request.headers.host ?? "").split(":")[0];
    if (hostHeader && url.hostname !== hostHeader && !LOOPBACK_HOSTS.has(hostHeader)) {
      return null;
    }
    return origin;
  } catch {
    return null;
  }
}

function setCors(request, response) {
  const origin = browserOrigin(request);
  if (!origin) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "Content-Type,Idempotency-Key,Range,X-API-Key,X-File-Name");
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function apiKeyAuthorized(request) {
  const supplied = request.headers["x-api-key"];
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(config.apiKey);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function sessionToken(user, expiresAt = Date.now() + 8 * 60 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({ userId: user.id, expiresAt })).toString("base64url");
  const signature = createHmac("sha256", config.apiKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function sessionUser(request) {
  try {
    const cookies = Object.fromEntries(String(request.headers.cookie ?? "").split(";").map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([name, value]) => name && value));
    const [payload, suppliedSignature] = String(cookies.sip_session ?? "").split(".");
    if (!payload || !suppliedSignature) return null;
    const expectedSignature = createHmac("sha256", config.apiKey).update(payload).digest("base64url");
    const expected = Buffer.from(expectedSignature); const supplied = Buffer.from(suppliedSignature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.userId || Number(session.expiresAt) <= Date.now()) return null;
    const user = system.getUser(session.userId);
    return user?.enabled ? user : null;
  } catch { return null; }
}

function authorized(request) { return apiKeyAuthorized(request) || Boolean(sessionUser(request)); }
function adminAuthorized(request) { return apiKeyAuthorized(request) || sessionUser(request)?.role === "系统管理员"; }

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function mediaPreviewToken(id) {
  return createHmac("sha256", config.apiKey).update(`media-preview:${id}`).digest("base64url");
}

function validMediaPreview(id, supplied) {
  if (!supplied) return false;
  const expected = Buffer.from(mediaPreviewToken(id));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function mediaFilePayload(file) {
  return { ...file, previewToken: mediaPreviewToken(file.id) };
}

function playlistPayload(playlist) {
  return { ...playlist, files: playlist.files.map(mediaFilePayload) };
}

// Fisher-Yates 洗牌；返回新数组，不修改入参。
function shufflePaths(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

async function readJson(request) {
  try {
    return JSON.parse((await readBody(request, 64 * 1024)).toString("utf8") || "{}");
  } catch (error) {
    if (error?.status) throw error;
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

function audio(response, request, file, path) {
  const { size } = statSync(path);
  const range = request.headers.range;
  const common = {
    "content-type": file.contentType,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=0, must-revalidate",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
    "x-content-type-options": "nosniff",
  };
  if (typeof range === "string") {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) return json(response, 416, { error: "invalid_range" });
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
      response.writeHead(416, { "content-range": `bytes */${size}` });
      return response.end();
    }
    response.writeHead(206, { ...common, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}` });
    return createReadStream(path, { start, end }).pipe(response);
  }
  response.writeHead(200, { ...common, "content-length": size });
  return createReadStream(path).pipe(response);
}

async function route(request, response) {
  const requestId = randomUUID();
  response.setHeader("x-request-id", requestId);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const mediaContentMatch = url.pathname.match(/^\/api\/v1\/media\/files\/([^/]+)\/content$/);
  setCors(request, response);

  if (request.method === "OPTIONS" && browserOrigin(request)) {
    response.writeHead(204);
    return response.end();
  }

  if (request.method === "GET" && url.pathname === "/health") {
    const result = await esl.execute("status");
    return json(response, 200, { status: "ok", freeswitch: result.body.split("\n")[0] });
  }

  if (request.method === "GET" && mediaContentMatch && validMediaPreview(mediaContentMatch[1], url.searchParams.get("preview"))) {
    const resolved = media.resolveFile(mediaContentMatch[1]);
    return audio(response, request, resolved.file, resolved.path);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/auth/login") {
    const input = await readJson(request);
    const user = system.authenticate(input.username, input.password);
    if (!user) return json(response, 401, { error: "invalid_credentials", message: "用户名或密码错误", requestId });
    response.setHeader("set-cookie", `sip_session=${sessionToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
    return json(response, 200, { user, requestId });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/auth/logout") {
    response.setHeader("set-cookie", "sip_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return json(response, 200, { ok: true, requestId });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/auth/me") {
    const user = sessionUser(request);
    return user ? json(response, 200, { user, requestId }) : json(response, 401, { error: "unauthorized", requestId });
  }

  if (!authorized(request)) return json(response, 401, { error: "unauthorized", requestId });

  if (request.method === "GET" && url.pathname === "/api/v1/freeswitch/status") {
    const result = await esl.execute("status");
    return json(response, 200, { status: result.body, requestId });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/channels") {
    const result = await esl.execute("show channels as json");
    return json(response, 200, { ...JSON.parse(result.body || '{"row_count":0,"rows":[]}'), requestId });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/registrations") {
    const [registrations, channels] = await Promise.all([
      esl.execute("show registrations as json"),
      esl.execute("show channels as json"),
    ]);
    return json(response, 200, { ...terminalRegistry(registrations.body, channels.body, terminalMetadata.listNames(), zones.terminalZones()), requestId });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/system/config") return json(response, 200, { config: system.getConfig(), requestId });
  if (request.method === "PATCH" && url.pathname === "/api/v1/system/config") return adminAuthorized(request) ? json(response, 200, { config: system.updateConfig(await readJson(request)), requestId }) : json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
  if (request.method === "GET" && url.pathname === "/api/v1/users") return json(response, 200, { items: system.listUsers(), count: system.listUsers().length, requestId });
  if (request.method === "POST" && url.pathname === "/api/v1/users") return adminAuthorized(request) ? json(response, 201, { user: system.createUser(await readJson(request)), requestId }) : json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
  const userMatch = url.pathname.match(/^\/api\/v1\/users\/([^/]+)$/);
  if (request.method === "PATCH" && userMatch) return adminAuthorized(request) ? json(response, 200, { user: system.updateUser(userMatch[1], await readJson(request)), requestId }) : json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
  if (request.method === "DELETE" && userMatch) return adminAuthorized(request) ? json(response, 200, { user: system.deleteUser(userMatch[1]), requestId }) : json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
  if (request.method === "GET" && url.pathname === "/api/v1/permissions") return json(response, 200, { items: system.permissions(), requestId });
  if (request.method === "PATCH" && url.pathname === "/api/v1/permissions") return adminAuthorized(request) ? json(response, 200, { items: system.updatePermissions(await readJson(request)), requestId }) : json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });

  if (request.method === "GET" && url.pathname === "/api/v1/zones") return json(response, 200, { items: zones.list(), count: zones.list().length, requestId });
  if (request.method === "POST" && url.pathname === "/api/v1/zones") return json(response, 201, { zone: zones.create(await readJson(request)), requestId });
  const zoneMatch = url.pathname.match(/^\/api\/v1\/zones\/([^/]+)$/);
  if (request.method === "PATCH" && zoneMatch) return json(response, 200, { zone: zones.rename(zoneMatch[1], await readJson(request)), requestId });
  if (request.method === "DELETE" && zoneMatch) return json(response, 200, { zone: zones.delete(zoneMatch[1]), requestId });
  const zoneTerminalsMatch = url.pathname.match(/^\/api\/v1\/zones\/([^/]+)\/terminals$/);
  if (request.method === "PUT" && zoneTerminalsMatch) return json(response, 200, { zone: zones.assign(zoneTerminalsMatch[1], (await readJson(request)).terminalIds), requestId });

  const terminalMatch = url.pathname.match(/^\/api\/v1\/terminals\/([^/]+)$/);
  if (request.method === "PATCH" && terminalMatch) {
    return json(response, 200, { terminal: terminalMetadata.rename(decodeURIComponent(terminalMatch[1]), await readJson(request)), requestId });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/sip-accounts") {
    const [users, registrations, directory] = await Promise.all([
      esl.execute("list_users"),
      esl.execute("show registrations as json"),
      esl.execute(`xml_locate directory domain name ${config.domain}`),
    ]);
    return json(response, 200, { ...sipAccountRegistry(users.body, registrations.body, directory.body), server: { host: config.sipServerHost, domain: config.domain, port: config.sipPort, transports: ["TCP"] }, requestId });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/sip-accounts") {
    const account = sipAccounts.create(await readJson(request));
    await esl.execute("reloadxml");
    return json(response, 201, { account, requestId });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/sip-accounts/batch") {
    const input = await readJson(request);
    const accounts = sipAccounts.createMany(input.accounts);
    await esl.execute("reloadxml");
    return json(response, 201, { accounts, created: accounts.length, requestId });
  }

  if (request.method === "DELETE" && url.pathname === "/api/v1/sip-accounts/batch") {
    const input = await readJson(request);
    const accounts = sipAccounts.deleteMany(input.accounts);
    await esl.execute("reloadxml");
    await Promise.all(accounts.map(({ account }) => esl.execute(`sofia profile internal flush_inbound_reg ${account}@${config.domain}`).catch(() => undefined)));
    return json(response, 200, { accounts, deleted: accounts.length, requestId });
  }

  const sipAccountMatch = url.pathname.match(/^\/api\/v1\/sip-accounts\/([^/]+)$/);
  if (request.method === "DELETE" && sipAccountMatch) {
    const accountId = decodeURIComponent(sipAccountMatch[1]);
    const account = sipAccounts.delete(accountId);
    await esl.execute("reloadxml");
    await esl.execute(`sofia profile internal flush_inbound_reg ${accountId}@${config.domain}`).catch(() => undefined);
    return json(response, 200, { account, requestId });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/freeswitch/reload") {
    const result = await esl.execute("reloadxml");
    return json(response, 200, { result: result.body, requestId });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/broadcasts") {
    const items = broadcasts.list({ state: url.searchParams.get("state") || undefined });
    return json(response, 200, { items, count: items.length, requestId });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/schedules") {
    const items = schedules.list();
    return json(response, 200, { items, count: items.length, requestId });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/schedules") {
    return json(response, 201, { schedule: schedules.create(await readJson(request)), requestId });
  }
  const scheduleMatch = url.pathname.match(/^\/api\/v1\/schedules\/([^/]+)$/);
  if (request.method === "GET" && scheduleMatch) {
    const schedule = schedules.get(scheduleMatch[1]);
    return schedule ? json(response, 200, { schedule, requestId }) : json(response, 404, { error: "not_found", requestId });
  }
  if (request.method === "PATCH" && scheduleMatch) {
    return json(response, 200, { schedule: schedules.update(scheduleMatch[1], await readJson(request)), requestId });
  }
  if (request.method === "DELETE" && scheduleMatch) {
    return json(response, 200, { schedule: schedules.delete(scheduleMatch[1]), requestId });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/media/files") {
    const files = media.listFiles().map(mediaFilePayload);
    return json(response, 200, { items: files, count: files.length, requestId });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/media/files") {
    const encodedName = request.headers["x-file-name"];
    if (typeof encodedName !== "string") return json(response, 400, { error: "x-file-name header is required", requestId });
    let originalName;
    try { originalName = decodeURIComponent(encodedName); } catch { return json(response, 400, { error: "invalid x-file-name header", requestId }); }
    const file = media.createFile({
      originalName,
      contentType: request.headers["content-type"],
      buffer: await readBody(request, 50 * 1024 * 1024),
    });
    return json(response, 201, { file: mediaFilePayload(file), requestId });
  }

  if (request.method === "GET" && mediaContentMatch) {
    const resolved = media.resolveFile(mediaContentMatch[1]);
    return audio(response, request, resolved.file, resolved.path);
  }

  if (request.method === "GET" && url.pathname === "/api/v1/media/playlists") {
    const playlists = media.listPlaylists().map(playlistPayload);
    return json(response, 200, { items: playlists, count: playlists.length, requestId });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/media/playlists") {
    return json(response, 201, { playlist: playlistPayload(media.createPlaylist(await readJson(request))), requestId });
  }

  const playlistMatch = url.pathname.match(/^\/api\/v1\/media\/playlists\/([^/]+)$/);
  if (request.method === "PATCH" && playlistMatch) {
    return json(response, 200, { playlist: playlistPayload(media.renamePlaylist(playlistMatch[1], await readJson(request))), requestId });
  }

  const playlistItemMatch = url.pathname.match(/^\/api\/v1\/media\/playlists\/([^/]+)\/items$/);
  if (request.method === "POST" && playlistItemMatch) {
    const input = await readJson(request);
    return json(response, 200, { playlist: playlistPayload(media.addToPlaylist(playlistItemMatch[1], String(input.audioFileId ?? ""))), requestId });
  }

  const playlistItemDeleteMatch = url.pathname.match(/^\/api\/v1\/media\/playlists\/([^/]+)\/items\/([^/]+)$/);
  if (request.method === "DELETE" && playlistItemDeleteMatch) {
    return json(response, 200, { playlist: playlistPayload(media.removeFromPlaylist(playlistItemDeleteMatch[1], playlistItemDeleteMatch[2])), requestId });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/broadcasts") {
    const input = await readJson(request);
    // 播放模式：单次播放 / 循环播放 / 随机播放。缺省为单次，保持向后兼容。
    const playMode = input.playMode ? String(input.playMode).toUpperCase() : "ONCE";
    if (!["ONCE", "LOOP", "SHUFFLE"].includes(playMode)) {
      return json(response, 400, { error: "invalid_play_mode", message: "播放模式只能是单次播放、循环播放或随机播放", requestId });
    }
    input.playMode = playMode;
    if (Array.isArray(input.sources)) {
      if (!input.sources.length || input.sources.length > 50) return json(response, 400, { error: "invalid_sources", message: "播放内容需要选择 1-50 项", requestId });
      const paths = [];
      const sourceItems = [];
      for (const source of input.sources) {
        const id = String(source?.id ?? "");
        if (source?.type === "FILE") {
          const file = media.getFile(id);
          if (!file) return json(response, 404, { error: "media_not_found", message: "所选音频文件不存在", requestId });
          paths.push(file.freeswitchPath);
          sourceItems.push({ type: "FILE", id: file.id, name: file.originalName, fileCount: 1 });
        } else if (source?.type === "PLAYLIST") {
          const playlist = media.getPlaylist(id);
          if (!playlist) return json(response, 404, { error: "playlist_not_found", message: "所选播放列表不存在", requestId });
          if (!playlist.files.length) return json(response, 400, { error: "playlist_empty", message: `播放列表“${playlist.name}”中没有音频文件`, requestId });
          paths.push(...playlist.files.map((file) => file.freeswitchPath));
          sourceItems.push({ type: "PLAYLIST", id: playlist.id, name: playlist.name, fileCount: playlist.files.length });
        } else {
          return json(response, 400, { error: "invalid_source_type", message: "播放内容类型不正确", requestId });
        }
      }
      if (paths.length > 100) return json(response, 400, { error: "too_many_media_files", message: "展开播放列表后音频总数不能超过 100 个", requestId });
      // 随机播放：打乱展开后的音频顺序，FreeSWITCH 仍按 file_string 顺序播放。
      const orderedPaths = playMode === "SHUFFLE" ? shufflePaths(paths) : paths;
      input.audio = orderedPaths.length === 1 ? orderedPaths[0] : `file_string://${orderedPaths.join("!")}`;
      input.sourceType = sourceItems.length === 1 ? sourceItems[0].type : "MIXED";
      input.sourceId = sourceItems.length === 1 ? sourceItems[0].id : null;
      input.sourceName = sourceItems.map((source) => source.name).join("、");
      input.sourceItems = sourceItems;
    } else if (input.playlistId) {
      const playlist = media.getPlaylist(String(input.playlistId));
      if (!playlist) return json(response, 404, { error: "playlist_not_found", message: "播放列表不存在", requestId });
      if (!playlist.files.length) return json(response, 400, { error: "playlist_empty", message: "播放列表中没有音频文件", requestId });
      const playlistPaths = playlist.files.map((file) => file.freeswitchPath);
      input.audio = `file_string://${(playMode === "SHUFFLE" ? shufflePaths(playlistPaths) : playlistPaths).join("!")}`;
      input.sourceType = "PLAYLIST";
      input.sourceId = playlist.id;
      input.sourceName = playlist.name;
    }
    const result = await broadcasts.create(input, {
      idempotencyKey: typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined,
    });
    return json(response, result.replayed ? 200 : 202, { ...result, requestId });
  }

  const broadcastMatch = url.pathname.match(/^\/api\/v1\/broadcasts\/([^/]+)$/);
  if (request.method === "GET" && broadcastMatch) {
    const broadcast = broadcasts.get(broadcastMatch[1]);
    return broadcast ? json(response, 200, { broadcast, requestId }) : json(response, 404, { error: "not_found", requestId });
  }

  const cancelMatch = url.pathname.match(/^\/api\/v1\/broadcasts\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const broadcast = await broadcasts.cancel(cancelMatch[1]);
    return json(response, 200, { broadcast, requestId });
  }

  const hangupMatch = url.pathname.match(/^\/api\/v1\/channels\/([^/]+)\/hangup$/);
  if (request.method === "POST" && hangupMatch) {
    const channelUuid = hangupMatch[1];
    if (!uuidPattern.test(channelUuid)) return json(response, 400, { error: "invalid channel UUID", requestId });
    const result = await esl.execute(`uuid_kill ${channelUuid} NORMAL_CLEARING`);
    return json(response, 200, { result: result.body, requestId });
  }

  return json(response, 404, { error: "not_found", requestId });
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    const status = Number(error.status) || 502;
    json(response, status, {
      error: status === 502 ? "freeswitch_unavailable" : "request_failed",
      message: error.message,
      requestId: response.getHeader("x-request-id"),
    });
  });
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`FreeSWITCH API listening on port ${config.port}`);
  eventSubscriber.start(
    (event) => broadcasts.handleEvent(event),
    (state) => console.log(JSON.stringify({ component: "esl-events", ...state })),
  );
});

const scheduleTimer = setInterval(() => {
  schedules.runDue().catch((error) => console.error(JSON.stringify({ component: "schedule-runner", error: error.message })));
}, 1000);
scheduleTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(scheduleTimer);
    eventSubscriber.stop();
    server.close(() => process.exit(0));
  });
}
