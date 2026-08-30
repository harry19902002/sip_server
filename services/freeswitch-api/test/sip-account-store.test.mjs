import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SipAccountStore } from "../lib/sip-account-store.mjs";

test("creates and deletes a persistent FreeSWITCH directory account", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sip-account-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SipAccountStore(directory);
  store.create({ account: "86001", name: "测试 & 音箱", password: "secret123", displayNumber: "86001" });
  const document = readFileSync(join(directory, "86001.xml"), "utf8");
  assert.match(document, /测试 &amp; 音箱/);
  assert.match(document, /name="password" value="secret123"/);
  assert.throws(() => store.create({ account: "86001", name: "重复", password: "secret123" }), /already exists/);
  assert.deepEqual(store.delete("86001"), { account: "86001" });
});

test("rejects unsafe account names and short passwords", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sip-account-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SipAccountStore(directory);
  assert.throws(() => store.create({ account: "../bad", name: "bad", password: "secret123" }), /SIP account/);
  assert.throws(() => store.create({ account: "86001", name: "bad", password: "123" }), /6-128/);
});

test("creates and deletes SIP accounts in a validated batch", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sip-account-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SipAccountStore(directory);
  const created = store.createMany([
    { account: "87001", name: "东门终端", password: "123456" },
    { account: "87002", name: "西门终端", password: "secret789", displayNumber: "88002" },
  ]);
  assert.deepEqual(created.map((item) => item.account), ["87001", "87002"]);
  assert.match(readFileSync(join(directory, "87002.xml"), "utf8"), /value="88002"/);
  assert.deepEqual(store.deleteMany(["87001", "87002"]), [{ account: "87001" }, { account: "87002" }]);
});

test("batch creation is rejected before writing when an account conflicts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sip-account-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SipAccountStore(directory);
  store.create({ account: "87001", name: "已有账号", password: "123456" });
  assert.throws(() => store.createMany([
    { account: "87002", name: "新账号", password: "123456" },
    { account: "87001", name: "冲突账号", password: "123456" },
  ]), /already exists/);
  assert.throws(() => readFileSync(join(directory, "87002.xml"), "utf8"), /ENOENT/);
});
