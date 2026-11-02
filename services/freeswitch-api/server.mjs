import { createServer } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import * as fsModule from "node:fs";
import { EslClient, EslEventSubscriber } from "./lib/esl-client.mjs";
import { BroadcastStore } from "./lib/broadcast-store.mjs";
import { BroadcastService } from "./lib/broadcast-service.mjs";
import { MediaStore } from "./lib/media-store.mjs";
import { buildAudio, expandSources } from "./lib/play-source.mjs";
import { terminalRegistry } from "./lib/terminal-registry.mjs";
import { sipAccountRegistry } from "./lib/sip-account-registry.mjs";
import { SipAccountStore } from "./lib/sip-account-store.mjs";
import { provisionDefaultAccounts } from "./lib/sip-provisioner.mjs";
import { TerminalMetadataStore } from "./lib/terminal-metadata-store.mjs";
import { ZoneStore } from "./lib/zone-store.mjs";
import { ScheduleStore } from "./lib/schedule-store.mjs";
import { ScheduleService } from "./lib/schedule-service.mjs";
import { SystemStore } from "./lib/system-store.mjs";
import { dirname, join } from "node:path";
import { PresetStore } from "./lib/preset-store.mjs";
import { PresetService } from "./lib/preset-service.mjs";
import { buildZonePagingDialplan, writeZonePagingDialplan } from "./lib/zone-dialplan.mjs";
import { CODEC_CATALOG, CodecService, normalizeCodecPrefs } from "./lib/codec-service.mjs";
import { BackupService } from "./lib/backup-service.mjs";

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
  // 分区群呼拨号方案的输出目录（FreeSWITCH conf/dialplan）；留空则跳过生成
  zoneDialplanDir: process.env.ZONE_DIALPLAN_DIR ?? "",
  systemAdminUsername: process.env.SYSTEM_ADMIN_USERNAME ?? "admin",
  systemAdminPassword: process.env.SYSTEM_ADMIN_PASSWORD ?? "123456",
  // 预置 8XXX 号段账号使用的鉴权密码。Docker 部署时由 compose 从 .env 透传，
  // 与 vars.xml 的 default_password 保持一致；未设置则用内置默认值。
  sipDefaultPassword: process.env.SIP_DEFAULT_PASSWORD || undefined,
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
const presets = new PresetService({ store: new PresetStore(process.env.PRESET_DATA_FILE ?? join(dirname(config.dataFile), "presets.json"), {
  numberAvailable: (number) => !existsSync(join(config.sipDirectory, `${number}.xml`)),
}), media, zones, broadcasts, esl });
const system = new SystemStore(config.systemDataFile);
const codecs = new CodecService({ esl });
// 备份服务需要拿到全部 Store，才能做到「导入后内存状态与磁盘一致」。
// 回滚包与业务数据同目录，便于整包迁移时一起带走。
const backup = new BackupService({
  stores: { broadcasts: store, media, zones, schedules, presets, system, terminals: terminalMetadata },
  backupDirectory: process.env.BACKUP_DIRECTORY ?? join(dirname(config.dataFile), "backups"),
});
system.ensureBootstrapAdmin({ username: config.systemAdminUsername, name: "系统管理员", password: config.systemAdminPassword });

// ---------- 默认 SIP 账号预置 ----------
//
// 首次启动补齐 8XXX 号段（8001~8020）并清理随包演示分机，
// 之后启动只做幂等检查。详细理由见 lib/sip-provisioner.mjs。
//
// 文件写入与 reloadxml 分成两步，各自重试：账号文件是幂等落盘的，
// 即使写完后 reloadxml 一直失败（引擎未起），下次启动也会重新收敛。
async function provisionSipAccounts({ attempts = 40, intervalMs = 1500 } = {}) {
  let result;
  try {
    result = provisionDefaultAccounts(sipAccounts, {
      range: config.sipDefaultPassword ? { password: config.sipDefaultPassword } : {},
    });
  } catch (error) {
    console.error(JSON.stringify({ component: "sip-provision", error: error.message }));
    return null;
  }

  // 无改动即已收敛，不必打扰引擎
  if (!result.created.length && !result.pruned.length) return result;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await esl.execute("reloadxml");
      console.log(JSON.stringify({
        component: "sip-provision",
        event: "applied",
        created: result.created.length,
        pruned: result.pruned.length,
      }));
      return result;
    } catch (error) {
      // ESL 未就绪时 reloadxml 会失败；账号文件已落盘，等引擎起来再重试。
      if (attempt === attempts) {
        console.error(JSON.stringify({ component: "sip-provision", reloadFailed: error.message }));
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return result;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------- 分区群呼拨号方案 ----------
//
// 拨号方案按「号码 → 会议」映射生成。分区变化后需要重新生成并让
// FreeSWITCH 重载，否则新号码要等下次重启才生效。
// 该文件落在 FreeSWITCH 的 conf/dialplan 目录下（Windows 便携版为
// data/freeswitch/conf/dialplan），由 freeswitch.xml 自动 include。

/** dialplan 文件所在目录；未配置时跳过生成（例如容器里由挂载卷提供）。 */
function zoneDialplanDirectory() {
  return config.zoneDialplanDir;
}

async function syncZoneDialplan() {
  const directory = zoneDialplanDirectory();
  if (!directory) return { written: false, skipped: true };
  try {
    const content = buildZonePagingDialplan(zones.dialplanZones(), { domain: config.domain });
    const { written, path } = writeZonePagingDialplan(fsModule, directory, content);
    if (written) {
      // 让 FreeSWITCH 立即重新加载拨号方案，避免必须重启才能生效。
      await esl.execute("reloadxml").catch((error) => {
        console.error(JSON.stringify({ component: "zone-dialplan", error: error.message }));
      });
      console.log(JSON.stringify({ component: "zone-dialplan", event: "written", path }));
    }
    return { written, path };
  } catch (error) {
    // 生成失败不应影响分区本身的增删改，仅记录。
    console.error(JSON.stringify({ component: "zone-dialplan", error: error.message }));
    return { written: false, error: error.message };
  }
}

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
  // 编解码：GET 返回可选清单 + 已保存顺序 + FreeSWITCH 当前实际生效的顺序。
  if (request.method === "GET" && url.pathname === "/api/v1/system/codecs") {
    return json(response, 200, {
      items: CODEC_CATALOG,
      prefs: system.getConfig().codecPrefs,
      active: await codecs.activePrefs(),
      profile: codecs.profile,
      requestId,
    });
  }
  // PATCH 保存顺序；apply=true 时同时下发到 FreeSWITCH 并重启 SIP profile。
  // 应用失败（例如 FreeSWITCH 离线）不回滚已保存的配置，只把错误回给前端。
  if (request.method === "PATCH" && url.pathname === "/api/v1/system/codecs") {
    if (!adminAuthorized(request)) return json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
    const input = await readJson(request);
    const prefs = normalizeCodecPrefs(input.prefs);
    const stored = system.updateConfig({ codecPrefs: prefs }).codecPrefs;
    let applied = null;
    let applyError = null;
    if (input.apply !== false) {
      try { applied = await codecs.apply(stored, { restartProfile: input.restartProfile !== false }); }
      catch (error) { applyError = error.message ?? "编码格式已保存，但下发到 FreeSWITCH 失败"; }
    }
    return json(response, 200, { prefs: stored, applied, applyError, requestId });
  }
  if (request.method === "GET" && url.pathname === "/api/v1/users") return json(response, 200, { items: system.listUsers(), count: system.listUsers().length, requestId });
  if (request.method === "POST" && url.pathname === "/api/v1/users") return adminAuthorized(request) ? json(response, 201, { user: system.createUser(await readJson(request)), requestId }) : json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
  const userMatch = url.pathname.match(/^\/api\/v1\/users\/([^/]+)$/);
  if (request.method === "PATCH" && userMatch) return adminAuthorized(request) ? json(response, 200, { user: system.updateUser(userMatch[1], await readJson(request)), requestId }) : json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
  if (request.method === "DELETE" && userMatch) return adminAuthorized(request) ? json(response, 200, { user: system.deleteUser(userMatch[1]), requestId }) : json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
  if (request.method === "GET" && url.pathname === "/api/v1/permissions") return json(response, 200, { items: system.permissions(), requestId });
  if (request.method === "PATCH" && url.pathname === "/api/v1/permissions") return adminAuthorized(request) ? json(response, 200, { items: system.updatePermissions(await readJson(request)), requestId }) : json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });

  // ---------- 备份 / 导入 / 恢复出厂 ----------
  //
  // 三者都只允许系统管理员：它们会整体替换业务数据（含用户账号），
  // 属于不可由操作员触发的破坏性操作。
  if (request.method === "GET" && url.pathname === "/api/v1/system/backup/info") {
    if (!adminAuthorized(request)) return json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
    return json(response, 200, { manifest: backup.manifest(), rollbacks: backup.listRollbacks(), requestId });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/system/backup") {
    if (!adminAuthorized(request)) return json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
    const result = backup.create();
    // 直接以附件形式返回，浏览器会按 filename 下载
    const headers = {
      "content-type": "application/zip",
      "content-length": String(result.buffer.length),
      "content-disposition": `attachment; filename="${result.filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-request-id": String(requestId),
    };
    setCors(request, response);
    response.writeHead(200, headers);
    response.end(result.buffer);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/system/restore") {
    if (!adminAuthorized(request)) return json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
    // 备份包体积取决于音频总量。readBody 会把整个包读进内存，
    // 解压时还要再占一份，因此上限取 256MB（约为当前媒体库的 20 倍余量），
    // 而不是不设边界——否则一个超大包就能把进程内存打满。
    const body = await readBody(request, 256 * 1024 * 1024);
    if (!body.length) return json(response, 400, { error: "empty_body", message: "请求体为空，请上传备份 ZIP 文件", requestId });
    const result = await backup.import(body);
    // 分区数据可能整体变化，拨号方案必须重新生成并重载
    await syncZoneDialplan().catch((error) => console.error(JSON.stringify({ component: "zone-dialplan", error: error.message })));
    return json(response, 200, { ...result, requestId });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/system/reset") {
    if (!adminAuthorized(request)) return json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
    // 需要显式确认串，避免误调用（前端也会二次确认）
    const input = await readJson(request);
    if (String(input?.confirm ?? "") !== "RESET") {
      return json(response, 400, { error: "confirmation_required", message: "恢复出厂设置需要提交 confirm: \"RESET\"", requestId });
    }
    const result = await backup.factoryReset({
      defaultAdminUsername: config.systemAdminUsername,
      defaultAdminPassword: config.systemAdminPassword,
    });
    await syncZoneDialplan().catch((error) => console.error(JSON.stringify({ component: "zone-dialplan", error: error.message })));
    // 用户表已被重建，当前会话的 userId 随之失效。
    // 主动清除 cookie 并明确告知需要重新登录，避免前端拿到 200 后
    // 继续用失效会话请求、只看到一堆 401 却不知道为什么。
    response.setHeader("set-cookie", "sip_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return json(response, 200, { ...result, requiresRelogin: true, requestId });
  }

  if (request.method === "GET" && url.pathname === "/api/v1/system/rollback") {
    if (!adminAuthorized(request)) return json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
    return json(response, 200, { items: backup.listRollbacks(), requestId });
  }

  const rollbackDownload = url.pathname.match(/^\/api\/v1\/system\/rollback\/([^/]+)$/);
  if (request.method === "GET" && rollbackDownload) {
    if (!adminAuthorized(request)) return json(response, 403, { error: "forbidden", message: "需要系统管理员权限", requestId });
    const result = backup.readRollback(decodeURIComponent(rollbackDownload[1]));
    setCors(request, response);
    response.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(result.buffer.length),
      "content-disposition": `attachment; filename="${result.filename}"`,
      "cache-control": "no-store",
      "x-request-id": String(requestId),
    });
    response.end(result.buffer);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/zones") return json(response, 200, { items: zones.list(), count: zones.list().length, requestId });
  if (request.method === "POST" && url.pathname === "/api/v1/zones") {
    const zone = zones.create(await readJson(request));
    await syncZoneDialplan();
    return json(response, 201, { zone, requestId });
  }
  const zoneMatch = url.pathname.match(/^\/api\/v1\/zones\/([^/]+)$/);
  if (request.method === "PATCH" && zoneMatch) {
    const zone = zones.update(zoneMatch[1], await readJson(request));
    await syncZoneDialplan();
    return json(response, 200, { zone, requestId });
  }
  if (request.method === "DELETE" && zoneMatch) {
    const zone = zones.delete(zoneMatch[1]);
    await syncZoneDialplan();
    return json(response, 200, { zone, requestId });
  }
  const zoneTerminalsMatch = url.pathname.match(/^\/api\/v1\/zones\/([^/]+)\/terminals$/);
  if (request.method === "PUT" && zoneTerminalsMatch) {
    const zone = zones.assign(zoneTerminalsMatch[1], (await readJson(request)).terminalIds);
    await syncZoneDialplan();
    return json(response, 200, { zone, requestId });
  }

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

  if (request.method === "GET" && url.pathname === "/api/v1/presets") {
    const items = presets.list();
    return json(response, 200, { items, count: items.length, requestId });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/presets") {
    return json(response, 201, { preset: presets.create(await readJson(request)), requestId });
  }
  const presetMatch = url.pathname.match(/^\/api\/v1\/presets\/([^/]+)$/);
  if (request.method === "GET" && presetMatch) {
    const preset = presets.get(presetMatch[1]);
    return preset ? json(response, 200, { preset, requestId }) : json(response, 404, { error: "not_found", requestId });
  }
  if (request.method === "PATCH" && presetMatch) return json(response, 200, { preset: presets.update(presetMatch[1], await readJson(request)), requestId });
  if (request.method === "DELETE" && presetMatch) return json(response, 200, { preset: presets.delete(presetMatch[1]), requestId });
  const presetAction = url.pathname.match(/^\/api\/v1\/presets\/([^/]+)\/(play|stop)$/);
  if (request.method === "POST" && presetAction) {
    const preset = presetAction[2] === "play" ? await presets.start(presetAction[1]) : await presets.stop(presetAction[1]);
    return json(response, 200, { preset, requestId });
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
    // Only PresetService may associate a task with a SIP control channel.
    delete input.presetId;
    delete input.controllerUuid;
    // 播放模式：单次播放 / 循环播放 / 随机播放。缺省为单次，保持向后兼容。
    const playMode = input.playMode ? String(input.playMode).toUpperCase() : "ONCE";
    if (!["ONCE", "LOOP", "SHUFFLE"].includes(playMode)) {
      return json(response, 400, { error: "invalid_play_mode", message: "播放模式只能是单次播放、循环播放或随机播放", requestId });
    }
    input.playMode = playMode;
    if (Array.isArray(input.sources) || input.playlistId) {
      let expanded;
      try {
        expanded = expandSources({ sources: input.sources, playlistId: input.playlistId, media });
      } catch (error) {
        return json(response, error.status ?? 400, { error: "invalid_sources", message: error.message, requestId });
      }
      // 随机播放：打乱展开后的音频顺序，FreeSWITCH 仍按 file_string 顺序播放。
      input.audio = buildAudio(expanded.paths, playMode);
      input.sourceType = expanded.sourceType;
      input.sourceId = expanded.sourceId;
      input.sourceName = expanded.sourceName;
      input.sourceItems = expanded.sourceItems;
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

  // 调整「播放中」任务的音量：对仍未结束的目标信道实时生效。
  const volumeMatch = url.pathname.match(/^\/api\/v1\/broadcasts\/([^/]+)\/volume$/);
  if (request.method === "POST" && volumeMatch) {
    const input = await readJson(request);
    const volume = Number(input.volume);
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
      return json(response, 400, { error: "invalid_volume", message: "音量必须是 0 到 100 之间的整数", requestId });
    }
    const result = await broadcasts.setVolume(volumeMatch[1], volume);
    return json(response, 200, { ...result, requestId });
  }

  // 重发已结束的广播：复用原任务的播放内容、目标与音量，新建一条任务记录。
  const replayMatch = url.pathname.match(/^\/api\/v1\/broadcasts\/([^/]+)\/replay$/);
  if (request.method === "POST" && replayMatch) {
    const result = await broadcasts.replay(replayMatch[1], {
      idempotencyKey: typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined,
    });
    return json(response, 202, { ...result, requestId });
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
  // 预置默认 SIP 账号：异步执行，不阻塞接口监听
  provisionSipAccounts().catch((error) => {
    console.error(JSON.stringify({ component: "sip-provision", error: error.message }));
  });
  eventSubscriber.start(
    (event) => {
      broadcasts.handleEvent(event);
      presets.handleEvent(event).catch((error) => console.error(JSON.stringify({ component: "preset-events", error: error.message })));
    },
    (state) => console.log(JSON.stringify({ component: "esl-events", ...state })),
  );
  // 启动时生成一次分区群呼拨号方案：保证「存量分区」在进程重启后
  // 依然可以直接拨打分区号群呼，而不必等一次分区编辑触发。
  syncZoneDialplan().catch((error) => {
    console.error(JSON.stringify({ component: "zone-dialplan", error: error.message }));
  });
});

const scheduleTimer = setInterval(() => {
  schedules.runDue().catch((error) => console.error(JSON.stringify({ component: "schedule-runner", error: error.message })));
}, 1000);
scheduleTimer.unref();

const presetTimer = setInterval(() => {
  presets.reconcile().catch((error) => console.error(JSON.stringify({ component: "preset-runner", error: error.message })));
}, 3000);
presetTimer.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(scheduleTimer);
    clearInterval(presetTimer);
    // 清理所有「到时自动停止」的定时器，避免退出时残留
    for (const broadcastId of [...schedules.pendingStops.keys()]) schedules.cancelPendingStop(broadcastId);
    eventSubscriber.stop();
    server.close(() => process.exit(0));
  });
}
