import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&apos;");
}

export class SipAccountStore {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  file(account) {
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(account)) throw problem("SIP account must contain 2-32 letters, numbers, dots, underscores, or hyphens");
    return join(this.directory, `${account}.xml`);
  }

  prepare(input) {
    const account = String(input.account ?? "").trim();
    const name = String(input.name ?? "").trim();
    const password = String(input.password ?? "");
    const displayNumber = String(input.displayNumber ?? account).trim() || account;
    const path = this.file(account);
    if (/^88\d{4}$/.test(account) || /^88\d{4}$/.test(displayNumber)) throw problem("880000-889999 为预设广播保留号码，请使用其他 SIP 账号和显示号码", 409);
    if (!name || name.length > 80) throw problem("account name must contain 1-80 characters");
    if (password.length < 6 || password.length > 128) throw problem("password must contain 6-128 characters");
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(displayNumber)) throw problem("display number contains unsupported characters");
    const document = `<include>\n  <user id="${xml(account)}">\n    <params>\n      <param name="password" value="${xml(password)}"/>\n      <param name="vm-password" value="${xml(account)}"/>\n    </params>\n    <variables>\n      <variable name="accountcode" value="${xml(account)}"/>\n      <variable name="user_context" value="default"/>\n      <variable name="effective_caller_id_name" value="${xml(name)}"/>\n      <variable name="effective_caller_id_number" value="${xml(displayNumber)}"/>\n      <variable name="outbound_caller_id_name" value="${xml(name)}"/>\n      <variable name="outbound_caller_id_number" value="${xml(displayNumber)}"/>\n      <variable name="callgroup" value="techsupport"/>\n    </variables>\n  </user>\n</include>\n`;
    return { account, name, displayNumber, path, document };
  }

  create(input) {
    const prepared = this.prepare(input);
    if (existsSync(prepared.path)) throw problem("SIP account already exists", 409);
    writeFileSync(prepared.path, prepared.document, { encoding: "utf8", flag: "wx", mode: 0o644 });
    return { account: prepared.account, name: prepared.name, displayNumber: prepared.displayNumber };
  }

  createMany(inputs) {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 200) throw problem("accounts must contain 1-200 items");
    const prepared = inputs.map((input) => this.prepare(input));
    const duplicate = prepared.find((item, index) => prepared.findIndex((candidate) => candidate.account === item.account) !== index);
    if (duplicate) throw problem(`duplicate SIP account in request: ${duplicate.account}`, 409);
    const existing = prepared.find((item) => existsSync(item.path));
    if (existing) throw problem(`SIP account already exists: ${existing.account}`, 409);
    for (const item of prepared) writeFileSync(item.path, item.document, { encoding: "utf8", flag: "wx", mode: 0o644 });
    return prepared.map(({ account, name, displayNumber }) => ({ account, name, displayNumber }));
  }

  deleteMany(accounts) {
    if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 200) throw problem("accounts must contain 1-200 items");
    const unique = [...new Set(accounts.map((account) => String(account).trim()))];
    if (unique.length !== accounts.length) throw problem("duplicate SIP account in request");
    const prepared = unique.map((account) => {
      if (["default", "example.com", "skinny-example"].includes(account)) throw problem("system directory files cannot be deleted", 403);
      return { account, path: this.file(account) };
    });
    const missing = prepared.find((item) => !existsSync(item.path));
    if (missing) throw problem(`SIP account not found: ${missing.account}`, 404);
    for (const item of prepared) unlinkSync(item.path);
    return prepared.map(({ account }) => ({ account }));
  }

  delete(account) {
    if (["default", "example.com", "skinny-example"].includes(account)) throw problem("system directory files cannot be deleted", 403);
    const path = this.file(account);
    if (!existsSync(path)) throw problem("SIP account not found", 404);
    unlinkSync(path);
    return { account };
  }
}
