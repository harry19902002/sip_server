import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { readFile } from "node:fs/promises";

const envText = await readFile(new URL("../.env", import.meta.url), "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => {
  const separator = line.indexOf("=");
  return [line.slice(0, separator), line.slice(separator + 1)];
}));

const extension = process.env.SIP_TEST_EXTENSION ?? "1000";
const password = process.env.SIP_TEST_PASSWORD ?? env.SIP_DEFAULT_PASSWORD;
const domain = process.env.SIP_TEST_DOMAIN ?? env.FREESWITCH_DOMAIN ?? "sip.local";
const apiKey = process.env.FREESWITCH_API_KEY ?? env.FREESWITCH_API_KEY;
const apiBase = process.env.SIP_TEST_API_BASE ?? "http://127.0.0.1:3001/api/v1";
const sipHost = process.env.SIP_TEST_HOST ?? "127.0.0.1";
const sipPort = Number(process.env.SIP_TEST_PORT ?? env.SIP_PORT ?? 5060);
const advertisedHost = process.env.SIP_TEST_ADVERTISED_HOST ?? "host.docker.internal";

assert.ok(password, "SIP_DEFAULT_PASSWORD is required");
assert.ok(apiKey, "FREESWITCH_API_KEY is required");

const sip = dgram.createSocket("udp4");
const rtp = dgram.createSocket("udp4");
const callId = `${randomBytes(10).toString("hex")}@127.0.0.1`;
const fromTag = randomBytes(6).toString("hex");
let cseq = 1;
let sipAddress;
let rtpAddress;
let rtpPackets = 0;
let inviteResolve;
let inviteReject;
const invitePromise = new Promise((resolve, reject) => { inviteResolve = resolve; inviteReject = reject; });
const responseWaiters = [];

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

function header(message, name) {
  return message.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim();
}

function allHeaders(message, name) {
  return [...message.matchAll(new RegExp(`^${name}:\\s*(.+)$`, "gim"))].map((match) => match[1].trim());
}

function sendSip(message, port = sipPort, host = sipHost) {
  return new Promise((resolve, reject) => sip.send(Buffer.from(message), port, host, (error) => error ? reject(error) : resolve()));
}

function waitForResponse(status, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for SIP ${status}`)), timeoutMs);
    responseWaiters.push({ status, resolve: (value) => { clearTimeout(timer); resolve(value); } });
  });
}

function buildRegister(authorization = "") {
  const lines = [
    `REGISTER sip:${domain} SIP/2.0`,
    `Via: SIP/2.0/UDP 127.0.0.1:${sipAddress.port};branch=z9hG4bK-${randomBytes(8).toString("hex")};rport`,
    "Max-Forwards: 70", `From: <sip:${extension}@${domain}>;tag=${fromTag}`, `To: <sip:${extension}@${domain}>`,
    `Call-ID: ${callId}`, `CSeq: ${cseq++} REGISTER`,
    `Contact: <sip:${extension}@${advertisedHost}:${sipAddress.port};transport=udp>;expires=300`, "Expires: 300",
  ];
  if (authorization) lines.push(`Authorization: ${authorization}`);
  return [...lines, "Content-Length: 0", "", ""].join("\r\n");
}

function digestAuthorization(challenge) {
  const values = Object.fromEntries([...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((match) => [match[1], match[2] ?? match[3]]));
  const uri = `sip:${domain}`;
  const qop = values.qop?.split(",")[0];
  const cnonce = randomBytes(8).toString("hex");
  const nc = "00000001";
  const ha1 = md5(`${extension}:${values.realm}:${password}`);
  const ha2 = md5(`REGISTER:${uri}`);
  const response = qop ? md5(`${ha1}:${values.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${values.nonce}:${ha2}`);
  return `Digest username="${extension}", realm="${values.realm}", nonce="${values.nonce}", uri="${uri}", response="${response}", algorithm=MD5${qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : ""}`;
}

async function answerInvite(message, remote) {
  assert.ok(message.startsWith("INVITE "), `Unexpected SIP request: ${message.split("\r\n", 1)[0]}`);
  const to = header(message, "To");
  const toWithTag = /;tag=/.test(to) ? to : `${to};tag=${randomBytes(6).toString("hex")}`;
  const sdp = [
    "v=0", `o=${extension} 1 1 IN IP4 127.0.0.1`, "s=SIP broadcast integration test",
    `c=IN IP4 ${advertisedHost}`, "t=0 0", `m=audio ${rtpAddress.port} RTP/AVP 0`, "a=rtpmap:0 PCMU/8000", "a=sendrecv", "",
  ].join("\r\n");
  const response = [
    "SIP/2.0 200 OK", ...allHeaders(message, "Via").map((via) => `Via: ${via}`), `From: ${header(message, "From")}`,
    `To: ${toWithTag}`, `Call-ID: ${header(message, "Call-ID")}`, `CSeq: ${header(message, "CSeq")}`,
    `Contact: <sip:${extension}@${advertisedHost}:${sipAddress.port}>`, "Content-Type: application/sdp",
    `Content-Length: ${Buffer.byteLength(sdp)}`, "", sdp,
  ].join("\r\n");
  await sendSip(response, remote.port, remote.address);
  inviteResolve();
}

sip.on("message", (buffer, remote) => {
  const message = buffer.toString("utf8");
  const status = message.match(/^SIP\/2\.0\s+(\d+)/)?.[1];
  if (status) {
    const index = responseWaiters.findIndex((waiter) => waiter.status === status);
    if (index >= 0) responseWaiters.splice(index, 1)[0].resolve(message);
    return;
  }
  if (message.startsWith("INVITE ")) answerInvite(message, remote).catch(inviteReject);
  if (message.startsWith("BYE ")) {
    const response = ["SIP/2.0 200 OK", ...allHeaders(message, "Via").map((value) => `Via: ${value}`),
      `From: ${header(message, "From")}`, `To: ${header(message, "To")}`, `Call-ID: ${header(message, "Call-ID")}`,
      `CSeq: ${header(message, "CSeq")}`, "Content-Length: 0", "", ""].join("\r\n");
    sendSip(response, remote.port, remote.address).catch(inviteReject);
  }
});
rtp.on("message", () => { rtpPackets += 1; });

await new Promise((resolve) => sip.bind(0, "127.0.0.1", resolve));
await new Promise((resolve) => rtp.bind(0, "127.0.0.1", resolve));
sipAddress = sip.address();
rtpAddress = rtp.address();

try {
  const unauthorizedPromise = waitForResponse("401");
  await sendSip(buildRegister());
  const unauthorized = await unauthorizedPromise;
  const challenge = header(unauthorized, "WWW-Authenticate");
  assert.ok(challenge, "REGISTER challenge did not contain WWW-Authenticate");
  const okPromise = waitForResponse("200");
  await sendSip(buildRegister(digestAuthorization(challenge)));
  await okPromise;

  const createResponse = await fetch(`${apiBase}/broadcasts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "idempotency-key": `sip-e2e-${Date.now()}` },
    body: JSON.stringify({ name: "SIP 端到端测试", targets: [extension], audio: "tone_stream://%(2000,0,440)", volume: 75 }),
  });
  assert.equal(createResponse.status, 202, await createResponse.clone().text());
  const created = await createResponse.json();
  await Promise.race([invitePromise, new Promise((_, reject) => setTimeout(() => reject(new Error("FreeSWITCH did not originate an INVITE")), 10000))]);

  let task;
  const deadline = Date.now() + 15000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const detailResponse = await fetch(`${apiBase}/broadcasts/${created.broadcast.id}`, { headers: { "x-api-key": apiKey } });
    assert.equal(detailResponse.status, 200);
    task = (await detailResponse.json()).broadcast;
  } while (!new Set(["SUCCEEDED", "PARTIAL_FAILED", "FAILED", "CANCELED"]).has(task.state) && Date.now() < deadline);

  assert.equal(task.state, "SUCCEEDED", JSON.stringify(task));
  assert.ok(rtpPackets > 0, "No RTP audio packets were received");
  console.log(JSON.stringify({ registered: extension, broadcastId: task.id, state: task.state, rtpPackets }));
} finally {
  sip.close();
  rtp.close();
}
