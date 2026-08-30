import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MediaStore } from "../lib/media-store.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sip-media-test-"));
  return { directory, store: new MediaStore({ metadataFile: join(directory, "media.json"), mediaDirectory: join(directory, "files") }) };
}

const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(32)]);
const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(32)]);

test("stores WAV and MP3 files and persists metadata", (t) => {
  const { directory, store } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = store.createFile({ originalName: "提示音.wav", contentType: "audio/wav", buffer: wav });
  const second = store.createFile({ originalName: "音乐.mp3", contentType: "audio/mpeg", buffer: mp3 });
  assert.deepEqual(store.listFiles().map((item) => item.format).sort(), ["MP3", "WAV"]);
  assert.match(first.freeswitchPath, /\.wav$/);
  assert.match(second.freeswitchPath, /\.mp3$/);
  const reloaded = new MediaStore({ metadataFile: join(directory, "media.json"), mediaDirectory: join(directory, "files") });
  assert.equal(reloaded.listFiles().length, 2);
});

test("creates, renames, and adds each audio file to a playlist once", (t) => {
  const { directory, store } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = store.createFile({ originalName: "提示音.wav", contentType: "audio/wav", buffer: wav });
  const playlist = store.createPlaylist({ name: "安全播报" });
  assert.equal(store.renamePlaylist(playlist.id, { name: "日常安全播报" }).name, "日常安全播报");
  store.addToPlaylist(playlist.id, file.id);
  const updated = store.addToPlaylist(playlist.id, file.id);
  assert.equal(updated.files.length, 1);
  assert.equal(updated.files[0].id, file.id);
  assert.equal(store.removeFromPlaylist(playlist.id, file.id).files.length, 0);
});

test("rejects duplicate playlist names when renaming", (t) => {
  const { directory, store } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  store.createPlaylist({ name: "列表一" });
  const second = store.createPlaylist({ name: "列表二" });
  assert.throws(() => store.renamePlaylist(second.id, { name: "列表一" }), /already exists/);
});

test("rejects unsupported or spoofed audio", (t) => {
  const { directory, store } = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => store.createFile({ originalName: "payload.exe", buffer: mp3 }), /only WAV and MP3/);
  assert.throws(() => store.createFile({ originalName: "fake.mp3", buffer: Buffer.from("not audio") }), /not a valid MP3/);
});
