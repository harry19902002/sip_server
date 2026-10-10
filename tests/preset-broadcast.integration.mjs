// Runs against a real local FreeSWITCH with an isolated API/data directory.
// SIP_ACCOUNT_DIRECTORY must be the engine's conf/directory/default directory.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), "sip-preset-e2e-"));
const sipDirectory = process.env.SIP_ACCOUNT_DIRECTORY;
const host = process.env.SIP_HOST ?? "127.0.0.1";
const port = Number(process.env.SIP_PORT ?? 5060);
const domain = process.env.FREESWITCH_DOMAIN ?? "sip.local";
const password = randomBytes(12).toString("hex");
const apiKey = randomBytes(24).toString("hex");
const apiPort = Number(process.env.PRESET_E2E_API_PORT ?? 3301);
const apiBase = `http://127.0.0.1:${apiPort}/api/v1`;
assert.ok(sipDirectory && process.env.ESL_PASSWORD, "SIP_ACCOUNT_DIRECTORY and ESL_PASSWORD are required");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(callback, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await callback()) return; await sleep(100); }
  throw new Error(`Timed out: ${description}`);
}
const header = (message, name) => message.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim();
const headers = (message, name) => [...message.matchAll(new RegExp(`^${name}:\\s*(.+)$`, "gim"))].map((match) => match[1].trim());
const md5 = (value) => createHash("md5").update(value).digest("hex");
function digest(challenge, username, method, uri) {
  const values = Object.fromEntries([...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((match) => [match[1], match[2] ?? match[3]]));
  const qop = values.qop?.split(",")[0]; const cnonce = randomBytes(8).toString("hex"); const nc = "00000001";
  const a1 = md5(`${username}:${values.realm}:${password}`); const a2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${a1}:${values.nonce}:${nc}:${cnonce}:${qop}:${a2}`) : md5(`${a1}:${values.nonce}:${a2}`);
  return `Digest username="${username}", realm="${values.realm}", nonce="${values.nonce}", uri="${uri}", response="${response}", algorithm=MD5${qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : ""}`;
}

class SipEndpoint {
  constructor(extension) {
    this.extension = extension; this.socket = dgram.createSocket("udp4"); this.rtp = dgram.createSocket("udp4");
    this.sequence = 0; this.transactions = new Map(); this.rtpPackets = 0; this.byes = 0;
    this.dialogs = [];
    this.rtp.on("message", () => this.rtpPackets++);
    this.socket.on("message", (buffer, remote) => {
      const message = buffer.toString();
      const status = Number(message.match(/^SIP\/2\.0\s+(\d+)/)?.[1]);
      if (status) {
        if (status >= 200) this.transactions.get(`${header(message, "Call-ID")}:${header(message, "CSeq")}`)?.(message);
        return;
      }
      if (message.startsWith("INVITE ")) {
        const tag = md5(header(message, "Call-ID")).slice(0, 10);
        this.respond(message, remote, this.sdp(), `${header(message, "To")};tag=${tag}`);
      } else if (message.startsWith("BYE ") || message.startsWith("OPTIONS ")) {
        if (message.startsWith("BYE ")) {
          this.byes++;
          const dialog = this.dialogs.find((item) => item.callId === header(message, "Call-ID"));
          if (dialog) dialog.closed = true;
        }
        this.respond(message, remote);
      }
    });
  }
  async bind() {
    await new Promise((resolve) => this.socket.bind(0, "0.0.0.0", resolve));
    await new Promise((resolve) => this.rtp.bind(0, "0.0.0.0", resolve));
    this.contact = `<sip:${this.extension}@${host}:${this.socket.address().port};transport=udp>`;
  }
  sdp() { return ["v=0", `o=${this.extension} 1 1 IN IP4 ${host}`, "s=Preset integration", `c=IN IP4 ${host}`, "t=0 0", `m=audio ${this.rtp.address().port} RTP/AVP 0`, "a=rtpmap:0 PCMU/8000", "a=sendrecv", ""].join("\r\n"); }
  send(message, targetPort = port, targetHost = host) { this.socket.send(Buffer.from(message), targetPort, targetHost); }
  respond(message, remote, body = "", to = header(message, "To")) {
    this.send(["SIP/2.0 200 OK", ...headers(message, "Via").map((value) => `Via: ${value}`), `From: ${header(message, "From")}`, `To: ${to}`, `Call-ID: ${header(message, "Call-ID")}`, `CSeq: ${header(message, "CSeq")}`, `Contact: ${this.contact}`, ...(body ? ["Content-Type: application/sdp"] : []), `Content-Length: ${Buffer.byteLength(body)}`, "", body].join("\r\n"), remote.port, remote.address);
  }
  request(method, uri, { callId = `${randomBytes(10).toString("hex")}@${host}`, from = `<sip:${this.extension}@${domain}>;tag=${randomBytes(6).toString("hex")}`, to = `<${uri}>`, sequence = ++this.sequence, body = "", extra = [], wait = true } = {}) {
    const message = [`${method} ${uri} SIP/2.0`, `Via: SIP/2.0/UDP ${host}:${this.socket.address().port};branch=z9hG4bK-${randomBytes(8).toString("hex")};rport`, "Max-Forwards: 70", `From: ${from}`, `To: ${to}`, `Call-ID: ${callId}`, `CSeq: ${sequence} ${method}`, `Contact: ${this.contact}`, ...extra, ...(body ? ["Content-Type: application/sdp"] : []), `Content-Length: ${Buffer.byteLength(body)}`, "", body].join("\r\n");
    if (!wait) { this.send(message); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const key = `${callId}:${sequence} ${method}`;
      const timer = setTimeout(() => { this.transactions.delete(key); reject(new Error(`SIP ${method} timed out`)); }, 5000);
      this.transactions.set(key, (response) => { clearTimeout(timer); this.transactions.delete(key); resolve(response); });
      this.send(message);
    });
  }
  async register(expires = 300) {
    const uri = `sip:${domain}`;
    const challenge = await this.request("REGISTER", uri, { extra: [`Expires: ${expires}`] });
    assert.match(challenge, /^SIP\/2.0 401/);
    const result = await this.request("REGISTER", uri, { extra: [`Expires: ${expires}`, `Authorization: ${digest(header(challenge, "WWW-Authenticate"), this.extension, "REGISTER", uri)}`] });
    assert.match(result, /^SIP\/2.0 200/);
  }
  async dial(number) {
    const uri = `sip:${number}@${domain}`;
    const callId = `${randomBytes(10).toString("hex")}@${host}`;
    const from = `<sip:${this.extension}@${domain}>;tag=${randomBytes(6).toString("hex")}`;
    let sequence = ++this.sequence;
    let response = await this.request("INVITE", uri, { callId, from, sequence, body: this.sdp() });
    if (/^SIP\/2.0 (?:401|407)/.test(response)) {
      await this.request("ACK", uri, { callId, from, sequence, to: header(response, "To"), wait: false });
      const proxy = response.startsWith("SIP/2.0 407"); sequence = ++this.sequence;
      response = await this.request("INVITE", uri, { callId, from, sequence, body: this.sdp(), extra: [`${proxy ? "Proxy-Authorization" : "Authorization"}: ${digest(header(response, proxy ? "Proxy-Authenticate" : "WWW-Authenticate"), this.extension, "INVITE", uri)}`] });
    }
    assert.match(response, /^SIP\/2.0 200/, response.split("\r\n")[0]);
    const contact = header(response, "Contact").match(/<([^>]+)>/)?.[1] ?? uri;
    const to = header(response, "To");
    await this.request("ACK", contact, { callId, from, to, sequence, wait: false });
    const dialog = { callId, closed: false, hangup: async () => {
      const result = await this.request("BYE", contact, { callId, from, to }); assert.match(result, /^SIP\/2.0 200/);
      dialog.closed = true;
    } };
    this.dialogs.push(dialog); return dialog;
  }
  close() { this.socket.close(); this.rtp.close(); }
}

let server;
let serverOutput = "";
const endpoints = []; const accounts = []; const presetIds = [];
function startServer() {
  server = spawn(process.execPath, [join(project, "services/freeswitch-api/server.mjs")], { cwd: project, windowsHide: true,
    env: { ...process.env, PORT: String(apiPort), API_KEY: apiKey, SIP_DIRECTORY: sipDirectory,
      BROADCAST_DATA_FILE: join(directory, "broadcasts.json"), MEDIA_DATA_FILE: join(directory, "media.json"), MEDIA_DIRECTORY: join(directory, "media"),
      MEDIA_FREESWITCH_PREFIX: join(directory, "media").replaceAll("\\", "/"), AUDIO_ROOTS: directory.replaceAll("\\", "/"),
      TERMINAL_METADATA_FILE: join(directory, "terminals.json"), ZONE_DATA_FILE: join(directory, "zones.json"), SCHEDULE_DATA_FILE: join(directory, "schedules.json"),
      SYSTEM_DATA_FILE: join(directory, "system.json"), PRESET_DATA_FILE: join(directory, "presets.json"), SYSTEM_ADMIN_PASSWORD: password } });
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
}
async function stopServer() { if (server && server.exitCode === null) { server.kill(); await new Promise((resolve) => server.once("exit", resolve)); } }
async function api(path, { method = "GET", body, buffer } = {}) {
  const response = await fetch(`${apiBase}${path}`, { method, headers: { "x-api-key": apiKey, "content-type": buffer ? "audio/wav" : "application/json", ...(buffer ? { "x-file-name": "preset-e2e.wav" } : {}) }, body: buffer ?? (body ? JSON.stringify(body) : undefined) });
  const payload = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(payload)}`); return payload;
}
function wav(seconds = 1) {
  const data = Buffer.alloc(44 + 8000 * seconds * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36); data.writeUInt32LE(data.length - 44, 40);
  for (let index = 0; index < 8000 * seconds; index++) data.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / 8000) * 4000), 44 + index * 2);
  return data;
}
try {
  startServer();
  await until(() => Promise.resolve(serverOutput.includes('"connected":true')), "isolated API event subscription");
  for (let index = 0; index < 2; index++) {
    let extension;
    do { extension = `77${Math.floor(Math.random() * 1000000).toString().padStart(6, "0")}`; } while (existsSync(join(sipDirectory, `${extension}.xml`)));
    await api("/sip-accounts", { method: "POST", body: { account: extension, name: "Preset integration endpoint", password } });
    accounts.push(extension);
    const endpoint = new SipEndpoint(extension); endpoints.push(endpoint); await endpoint.bind(); await endpoint.register();
  }
  const [caller, target] = endpoints;
  const { zone } = await api("/zones", { method: "POST", body: { name: "Preset integration zone" } });
  await api(`/zones/${zone.id}/terminals`, { method: "PUT", body: { terminalIds: [`${target.extension}@${domain}`] } });
  const { file } = await api("/media/files", { method: "POST", buffer: wav(2) });
  const { preset } = await api("/presets", { method: "POST", body: { name: "Preset integration broadcast", zoneIds: [zone.id], sources: [{ type: "FILE", id: file.id }], playMode: "LOOP", volume: 60 } });
  presetIds.push(preset.id);
  const dialog = await caller.dial(preset.sipNumber);
  await until(async () => (await api(`/presets/${preset.id}`)).preset.broadcast?.targets.some((item) => item.answeredAt), "SIP-triggered target answer");
  await until(() => target.rtpPackets > 5, "RTP playback");
  const duplicate = await fetch(`${apiBase}/presets/${preset.id}/play`, { method: "POST", headers: { "x-api-key": apiKey } });
  assert.equal(duplicate.status, 409);
  await dialog.hangup();
  await until(async () => !(await api(`/presets/${preset.id}`)).preset.active, "caller hangup stops preset");
  assert.equal((await api("/broadcasts")).items[0].state, "CANCELED");
  await until(() => target.byes > 0, "target receives BYE");
  const { preset: web } = await api(`/presets/${preset.id}/play`, { method: "POST" });
  assert.ok(web.active); await api(`/presets/${preset.id}/stop`, { method: "POST" });
  assert.equal((await api(`/presets/${preset.id}`)).preset.active, false);
  // API restart retains the controller association and continues to follow hangup.
  const restartDialog = await caller.dial(preset.sipNumber);
  await until(async () => {
    const current = (await api(`/presets/${preset.id}`)).preset;
    return current.active && current.trigger === "SIP" && current.broadcast?.targets.some((item) => item.answeredAt);
  }, "restart test target answer");
  await stopServer(); serverOutput = ""; startServer();
  await until(() => Promise.resolve(serverOutput.includes('"connected":true')), "API reconnect after restart");
  assert.ok((await api(`/presets/${preset.id}`)).preset.active);
  await restartDialog.hangup();
  await until(async () => !(await api(`/presets/${preset.id}`)).preset.active, "hangup after API restart");
  await api(`/presets/${preset.id}`, { method: "PATCH", body: { playMode: "ONCE" } });
  const priorByes = caller.byes;
  await caller.dial(preset.sipNumber);
  await until(() => caller.byes > priorByes, "playback completion hangs up caller");
  await until(async () => !(await api(`/presets/${preset.id}`)).preset.active, "single playback completes");
  assert.equal((await api("/broadcasts")).items[0].state, "SUCCEEDED");
  console.log(JSON.stringify({ passed: true, sipNumber: preset.sipNumber, rtpPackets: target.rtpPackets, checks: ["SIP dial", "caller hangup", "target BYE", "web play/stop", "concurrent rejection", "API restart", "natural completion"] }));
} catch (error) {
  console.error(serverOutput);
  console.error(JSON.stringify(await api("/presets").catch(() => null)));
  console.error(JSON.stringify(await api("/broadcasts").catch(() => null)));
  throw error;
} finally {
  for (const id of presetIds) await api(`/presets/${id}/stop`, { method: "POST" }).catch(() => undefined);
  for (const endpoint of endpoints) for (const dialog of endpoint.dialogs) if (!dialog.closed) await dialog.hangup().catch(() => undefined);
  for (const endpoint of endpoints) await endpoint.register(0).catch(() => undefined);
  for (const account of accounts) await api(`/sip-accounts/${account}`, { method: "DELETE" }).catch(() => undefined);
  for (const endpoint of endpoints) endpoint.close();
  await stopServer();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + "\\") || resolve(directory).startsWith(resolve(tmpdir()) + "/"));
  rmSync(directory, { recursive: true, force: true });
}
