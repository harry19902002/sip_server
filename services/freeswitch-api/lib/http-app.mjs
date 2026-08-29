import { randomUUID, timingSafeEqual } from "node:crypto";

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
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

export function createRequestHandler({ apiKey, esl, broadcasts }) {
  const authorized = (request) => {
    const supplied = request.headers["x-api-key"];
    if (typeof supplied !== "string") return false;
    const expectedBuffer = Buffer.from(apiKey);
    const suppliedBuffer = Buffer.from(supplied);
    return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
  };

  const route = async (request, response) => {
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      const result = await esl.execute("status");
      return json(response, 200, { status: "ok", freeswitch: result.body.split("\n")[0] });
    }
    if (!authorized(request)) return json(response, 401, { error: "unauthorized", requestId });

    if (request.method === "GET" && url.pathname === "/api/v1/system/summary") {
      const [status, channels] = await Promise.all([esl.execute("status"), esl.execute("show channels as json")]);
      const channelData = JSON.parse(channels.body || '{"row_count":0,"rows":[]}');
      return json(response, 200, { status: "ok", freeswitch: status.body.split("\n")[0], activeChannels: channelData.row_count ?? 0, requestId });
    }
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
    if (request.method === "GET" && url.pathname === "/api/v1/media") return json(response, 200, { items: broadcasts.listMedia(), requestId });
    if (request.method === "GET" && url.pathname === "/api/v1/broadcasts") return json(response, 200, { items: broadcasts.listTasks(Number(url.searchParams.get("limit") ?? 50)), requestId });
    if (request.method === "POST" && url.pathname === "/api/v1/broadcasts") {
      const task = await broadcasts.createTask(await readJson(request));
      return json(response, 202, { task, requestId });
    }

    const taskMatch = url.pathname.match(/^\/api\/v1\/broadcasts\/([^/]+)$/);
    if (request.method === "GET" && taskMatch) return json(response, 200, { task: broadcasts.getTask(decodeURIComponent(taskMatch[1])), requestId });
    const cancelMatch = url.pathname.match(/^\/api\/v1\/broadcasts\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) return json(response, 200, { task: await broadcasts.cancelTask(decodeURIComponent(cancelMatch[1])), requestId });

    const hangupMatch = url.pathname.match(/^\/api\/v1\/channels\/([0-9a-f-]+)\/hangup$/i);
    if (request.method === "POST" && hangupMatch && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(hangupMatch[1])) {
      const result = await esl.execute(`uuid_kill ${hangupMatch[1]} NORMAL_CLEARING`);
      return json(response, 200, { result: result.body, requestId });
    }
    return json(response, 404, { error: "not_found", requestId });
  };

  return (request, response) => {
    route(request, response).catch((error) => {
      const status = Number(error.status) || 500;
      json(response, status, { error: status === 502 ? "freeswitch_unavailable" : status >= 500 ? "internal_error" : "request_failed", message: error.message, requestId: response.getHeader("x-request-id") });
    });
  };
}
