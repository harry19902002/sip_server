import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { EslClient } from "./lib/esl-client.mjs";

const config = {
  port: Number(process.env.PORT ?? 3001),
  apiKey: process.env.API_KEY ?? "",
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
const extensionPattern = /^[0-9]{2,12}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const audioPathPattern = /^\/(?:usr\/share\/freeswitch\/sounds|var\/lib\/freeswitch\/(?:storage|recordings))\/[a-zA-Z0-9_./-]+\.(?:wav|mp3)$/;

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

function authorized(request) {
  const supplied = request.headers["x-api-key"];
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(config.apiKey);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

async function route(request, response) {
  const requestId = randomUUID();
  response.setHeader("x-request-id", requestId);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    const result = await esl.execute("status");
    return json(response, 200, { status: "ok", freeswitch: result.body.split("\n")[0] });
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
    const result = await esl.execute("sofia status profile internal reg");
    return json(response, 200, { registrations: result.body, requestId });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/freeswitch/reload") {
    const result = await esl.execute("reloadxml");
    return json(response, 200, { result: result.body, requestId });
  }

  if (request.method === "POST" && url.pathname === "/api/v1/broadcasts") {
    const body = await readJson(request);
    const targets = Array.isArray(body.targets) ? [...new Set(body.targets.map(String))] : [];
    const audio = String(body.audio ?? "");
    const callerId = String(body.callerId ?? "9999");

    if (!targets.length || targets.length > 500 || targets.some((target) => !extensionPattern.test(target))) {
      return json(response, 400, { error: "targets must contain 1-500 numeric SIP extensions", requestId });
    }
    if (!audioPathPattern.test(audio)) {
      return json(response, 400, { error: "audio must be a WAV/MP3 file in an approved FreeSWITCH media directory", requestId });
    }
    if (!extensionPattern.test(callerId)) {
      return json(response, 400, { error: "callerId must be numeric", requestId });
    }

    const jobs = await Promise.all(targets.map(async (target) => {
      const channelUuid = randomUUID();
      const dialString = `{origination_uuid=${channelUuid},origination_caller_id_number=${callerId},ignore_early_media=true}user/${target}@${config.domain}`;
      const result = await esl.execute(`originate ${dialString} &playback(${audio})`, { background: true });
      return { target, channelUuid, jobUuid: result.jobUuid };
    }));
    return json(response, 202, { jobs, requestId });
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
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
