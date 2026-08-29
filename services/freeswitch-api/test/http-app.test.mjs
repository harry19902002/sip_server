import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { BroadcastService } from "../lib/broadcast-service.mjs";
import { createRequestHandler } from "../lib/http-app.mjs";

async function withServer(run) {
  const esl = { async execute(command) { return command.includes("channels") ? { body: '{"row_count":0,"rows":[]}' } : { body: "UP 0 years", jobUuid: "job-1" }; } };
  const broadcasts = new BroadcastService({ esl });
  const server = createServer(createRequestHandler({ apiKey: "test-secret", esl, broadcasts }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("protects business routes and exposes the media catalog", () => withServer(async (baseUrl) => {
  assert.equal((await fetch(`${baseUrl}/api/v1/media`)).status, 401);
  const response = await fetch(`${baseUrl}/api/v1/media`, { headers: { "x-api-key": "test-secret" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items.length, 3);
}));

test("creates, lists and cancels tasks over HTTP", () => withServer(async (baseUrl) => {
  const headers = { "content-type": "application/json", "x-api-key": "test-secret" };
  const createdResponse = await fetch(`${baseUrl}/api/v1/broadcasts`, { method: "POST", headers, body: JSON.stringify({ mediaId: "test-tone", targets: ["81001"] }) });
  assert.equal(createdResponse.status, 202);
  const created = (await createdResponse.json()).task;
  assert.equal(created.status, "accepted");

  const listed = await (await fetch(`${baseUrl}/api/v1/broadcasts`, { headers })).json();
  assert.equal(listed.items[0].id, created.id);
  const cancelled = await (await fetch(`${baseUrl}/api/v1/broadcasts/${created.id}/cancel`, { method: "POST", headers })).json();
  assert.equal(cancelled.task.status, "cancelled");
}));
