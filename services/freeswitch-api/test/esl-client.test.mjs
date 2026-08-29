import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { EslClient, parseEslFrames } from "../lib/esl-client.mjs";

test("parses an ESL frame with a body", () => {
  const payload = Buffer.from("Content-Type: api/response\nContent-Length: 5\n\nhello");
  const { frames, remainder } = parseEslFrames(payload);

  assert.equal(frames.length, 1);
  assert.equal(frames[0].headers["content-type"], "api/response");
  assert.equal(frames[0].body, "hello");
  assert.equal(remainder.length, 0);
});

test("retains an incomplete ESL frame", () => {
  const payload = Buffer.from("Content-Type: api/response\r\nContent-Length: 5\r\n\r\nhel");
  const { frames, remainder } = parseEslFrames(payload);

  assert.equal(frames.length, 0);
  assert.deepEqual(remainder, payload);
});

test("parses multiple frames from one packet", () => {
  const payload = Buffer.from(
    "Content-Type: auth/request\n\n" +
    "Content-Type: command/reply\nReply-Text: +OK%20accepted\n\n",
  );
  const { frames, remainder } = parseEslFrames(payload);

  assert.equal(frames.length, 2);
  assert.equal(frames[1].headers["reply-text"], "+OK accepted");
  assert.equal(remainder.length, 0);
});

test("authenticates and executes an API command", async (context) => {
  const server = net.createServer((socket) => {
    socket.write("Content-Type: auth/request\n\n");
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (input.includes("auth test-password\n\n") && !input.includes("api status\n\n")) {
        socket.write("Content-Type: command/reply\nReply-Text: +OK accepted\n\n");
      }
      if (input.includes("api status\n\n")) {
        socket.write("Content-Type: api/response\nContent-Length: 8\n\nUP 1 day");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const client = new EslClient({
    host: "127.0.0.1",
    port: address.port,
    password: "test-password",
    timeoutMs: 1000,
  });
  const result = await client.execute("status");

  assert.equal(result.body, "UP 1 day");
});
