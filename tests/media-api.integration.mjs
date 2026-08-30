import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const envText = await readFile(new URL("../.env", import.meta.url), "utf8");
const env = Object.fromEntries(envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => {
  const separator = line.indexOf("=");
  return [line.slice(0, separator), line.slice(separator + 1)];
}));
const apiKey = process.env.FREESWITCH_API_KEY ?? env.FREESWITCH_API_KEY;
const apiBase = process.env.SIP_TEST_API_BASE ?? "http://127.0.0.1:3001/api/v1";
const headers = { "x-api-key": apiKey };

function testToneWav() {
  const sampleRate = 8000;
  const samples = sampleRate / 4;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 9000), 44 + index * 2);
  return buffer;
}

let filesPayload = await (await fetch(`${apiBase}/media/files`, { headers })).json();
let file = filesPayload.items.find((item) => item.originalName === "媒体库测试音.wav");
if (!file) {
  const response = await fetch(`${apiBase}/media/files`, {
    method: "POST",
    headers: { ...headers, "content-type": "audio/wav", "x-file-name": encodeURIComponent("媒体库测试音.wav") },
    body: testToneWav(),
  });
  assert.equal(response.status, 201, await response.clone().text());
  file = (await response.json()).file;
}

let playlistsPayload = await (await fetch(`${apiBase}/media/playlists`, { headers })).json();
let playlist = playlistsPayload.items.find((item) => item.name === "系统测试播放列表");
if (!playlist) {
  const response = await fetch(`${apiBase}/media/playlists`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "系统测试播放列表", description: "用于验证上传、试听与列表关联" }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  playlist = (await response.json()).playlist;
}

const addResponse = await fetch(`${apiBase}/media/playlists/${playlist.id}/items`, {
  method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ audioFileId: file.id }),
});
assert.equal(addResponse.status, 200, await addResponse.clone().text());
playlist = (await addResponse.json()).playlist;
assert.ok(playlist.files.some((item) => item.id === file.id));

const audioResponse = await fetch(`${apiBase}/media/files/${file.id}/content`, { headers: { ...headers, range: "bytes=0-43" } });
assert.equal(audioResponse.status, 206);
assert.equal((await audioResponse.arrayBuffer()).byteLength, 44);
assert.match(audioResponse.headers.get("content-range"), /^bytes 0-43\//);

console.log(JSON.stringify({ fileId: file.id, format: file.format, playlistId: playlist.id, playlistItems: playlist.files.length, rangeStatus: audioResponse.status }));
