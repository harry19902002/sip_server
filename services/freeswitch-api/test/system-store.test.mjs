import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SystemStore } from "../lib/system-store.mjs";

test("persists system configuration and manages real users", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sip-system-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "system.json");
  const store = new SystemStore(file);
  const config = store.updateConfig({ organizationName: "测试组织", organizationCode: "TEST-ORG", contact: "值班室", phone: "10086", theme: "dark" });
  assert.equal(config.organizationName, "测试组织");
  assert.equal(config.theme, "dark");
  const user = store.createUser({ username: "operator.one", name: "一号操作员", role: "广播操作员", password: "secret123" });
  assert.equal(store.authenticate("operator.one", "secret123").id, user.id);
  assert.equal(store.authenticate("operator.one", "wrong-password"), null);
  assert.equal(store.updateUser(user.id, { enabled: false }).enabled, false);
  const restored = new SystemStore(file);
  assert.equal(restored.getConfig().organizationCode, "TEST-ORG");
  assert.equal(restored.getConfig().theme, "dark");
  assert.throws(() => restored.updateConfig({ theme: "unknown" }), /theme must be light or dark/);
  assert.equal(restored.listUsers().length, 1);
  assert.equal(restored.permissions().length, 6);
  const permissions = restored.permissions();
  permissions[1].operator = "禁止";
  assert.equal(restored.updatePermissions({ items: permissions })[1].operator, "禁止");
  assert.equal(new SystemStore(file).permissions()[1].operator, "禁止");
  assert.equal(restored.deleteUser(user.id).id, user.id);
});

test("creates a bootstrap administrator when no password-enabled user exists", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sip-system-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SystemStore(join(directory, "system.json"));
  const admin = store.ensureBootstrapAdmin({ username: "admin", name: "系统管理员", password: "123456" });
  assert.equal(admin.role, "系统管理员");
  assert.equal(store.authenticate("admin", "123456").username, "admin");
  assert.equal(store.listUsers()[0].passwordHash, undefined);
});
