import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }
function clone(value) { return structuredClone(value); }
function hashPassword(password) { const salt = randomBytes(16).toString("hex"); const hash = scryptSync(password, salt, 32).toString("hex"); return `scrypt$${salt}$${hash}`; }
function validPassword(password) { return typeof password === "string" && password.length >= 6 && password.length <= 128; }
function verifyPassword(password, encoded) { try { const [algorithm, salt, expectedHex] = String(encoded).split("$"); if (algorithm !== "scrypt" || !salt || !expectedHex) return false; const expected = Buffer.from(expectedHex, "hex"); const actual = scryptSync(password, salt, expected.length); return expected.length === actual.length && timingSafeEqual(expected, actual); } catch { return false; } }
function publicUser(user) { const safe = clone(user); delete safe.passwordHash; return safe; }

const defaultPermissions = [
  { capability: "查看总览与任务", admin: "全部数据", operator: "已授权分区与本人任务" },
  { capability: "发起实时广播", admin: "允许", operator: "允许" },
  { capability: "管理定时计划", admin: "允许", operator: "允许" },
  { capability: "管理终端与分区", admin: "允许", operator: "只读" },
  { capability: "管理 SIP 账号", admin: "允许", operator: "只读" },
  { capability: "用户与系统配置", admin: "允许", operator: "禁止" },
];

export class SystemStore {
  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {
      config: { organizationName: "广播组织", organizationCode: "SIP-BROADCAST", contact: "", phone: "", theme: "light", updatedAt: new Date().toISOString() },
      users: [],
      permissions: defaultPermissions,
    };
    if (!this.state.config || typeof this.state.config !== "object") this.state.config = {};
    if (!["light", "dark"].includes(this.state.config.theme)) this.state.config.theme = "light";
    if (!Array.isArray(this.state.users)) this.state.users = [];
    if (!Array.isArray(this.state.permissions)) this.state.permissions = defaultPermissions;
  }
  persist() { const temporary = `${this.file}.tmp`; writeFileSync(temporary, JSON.stringify(this.state, null, 2)); renameSync(temporary, this.file); }
  getConfig() { return clone(this.state.config); }
  updateConfig(input) {
    const organizationName = String(input.organizationName ?? this.state.config.organizationName ?? "").trim();
    const organizationCode = String(input.organizationCode ?? this.state.config.organizationCode ?? "").trim();
    const contact = String(input.contact ?? this.state.config.contact ?? "").trim();
    const phone = String(input.phone ?? this.state.config.phone ?? "").trim();
    const theme = String(input.theme ?? this.state.config.theme ?? "light");
    if (!organizationName || organizationName.length > 60) throw problem("organizationName must contain 1-60 characters");
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(organizationCode)) throw problem("organizationCode must contain 2-40 letters, numbers, underscores, or hyphens");
    if (contact.length > 80 || phone.length > 40) throw problem("contact or phone is too long");
    if (!["light", "dark"].includes(theme)) throw problem("theme must be light or dark");
    this.state.config = { organizationName, organizationCode, contact, phone, theme, updatedAt: new Date().toISOString() };
    this.persist(); return this.getConfig();
  }
  listUsers() { return this.state.users.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicUser); }
  getUser(id) { const user = this.state.users.find((item) => item.id === id); return user ? publicUser(user) : null; }
  ensureBootstrapAdmin({ username, name, password }) {
    if (this.state.users.some((user) => user.passwordHash)) return null;
    if (!validPassword(password)) throw problem("bootstrap administrator password must contain 6-128 characters");
    const existing = this.state.users.find((user) => user.username.toLowerCase() === String(username).toLowerCase());
    if (existing) { existing.name = name; existing.role = "系统管理员"; existing.enabled = true; existing.passwordHash = hashPassword(password); existing.updatedAt = new Date().toISOString(); this.persist(); return publicUser(existing); }
    return this.createUser({ username, name, role: "系统管理员", password });
  }
  authenticate(username, password) {
    const user = this.state.users.find((item) => item.username.toLowerCase() === String(username ?? "").trim().toLowerCase());
    return user?.enabled && verifyPassword(String(password ?? ""), user.passwordHash) ? publicUser(user) : null;
  }
  createUser(input) {
    const username = String(input.username ?? "").trim();
    const name = String(input.name ?? "").trim();
    const role = String(input.role ?? "广播操作员");
    const password = String(input.password ?? "");
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) throw problem("username must contain 3-40 safe characters");
    if (!name || name.length > 60) throw problem("name must contain 1-60 characters");
    if (!["系统管理员", "广播操作员"].includes(role)) throw problem("invalid role");
    if (!validPassword(password)) throw problem("password must contain 6-128 characters");
    if (this.state.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw problem("username already exists", 409);
    const now = new Date().toISOString(); const user = { id: randomUUID(), username, name, role, enabled: true, passwordHash: hashPassword(password), createdAt: now, updatedAt: now };
    this.state.users.push(user); this.persist(); return publicUser(user);
  }
  updateUser(id, input) {
    const user = this.state.users.find((item) => item.id === id); if (!user) throw problem("user not found", 404);
    if (input.name !== undefined) { const name = String(input.name).trim(); if (!name || name.length > 60) throw problem("name must contain 1-60 characters"); user.name = name; }
    if (input.role !== undefined) { const role = String(input.role); if (!["系统管理员", "广播操作员"].includes(role)) throw problem("invalid role"); user.role = role; }
    if (input.enabled !== undefined) user.enabled = Boolean(input.enabled);
    if (input.password !== undefined) { const password = String(input.password); if (!validPassword(password)) throw problem("password must contain 6-128 characters"); user.passwordHash = hashPassword(password); }
    user.updatedAt = new Date().toISOString(); this.persist(); return publicUser(user);
  }
  deleteUser(id) { const index = this.state.users.findIndex((item) => item.id === id); if (index < 0) throw problem("user not found", 404); const [user] = this.state.users.splice(index, 1); this.persist(); return publicUser(user); }
  permissions() { return clone(this.state.permissions); }
  updatePermissions(input) {
    const items = Array.isArray(input.items) ? input.items : [];
    if (!items.length || items.length > 50) throw problem("permissions must contain 1-50 items");
    const allowed = new Set(["允许", "只读", "禁止", "全部数据", "已授权分区与本人任务"]);
    const permissions = items.map((item) => {
      const capability = String(item.capability ?? "").trim();
      const admin = String(item.admin ?? "").trim();
      const operator = String(item.operator ?? "").trim();
      if (!capability || capability.length > 80) throw problem("permission capability must contain 1-80 characters");
      if (!allowed.has(admin) || !allowed.has(operator)) throw problem("invalid permission level");
      return { capability, admin, operator };
    });
    if (new Set(permissions.map((item) => item.capability)).size !== permissions.length) throw problem("permission capabilities must be unique");
    this.state.permissions = permissions;
    this.persist();
    return this.permissions();
  }
}
