// 默认 SIP 账号预置。
//
// 背景：FreeSWITCH 随包目录自带 1000~1019 演示分机，密码统一是 vars.xml 里的
// `default_password`（历史值 123456）。这两个值都过于通用——号码是教科书示例，
// 密码是弱口令，任何扫描器都能猜中。本项目改为预置 8XXX 号段的独立账号。
//
// 设计要点：
//   1. **幂等**：只补齐缺失的账号，绝不覆盖已存在的账号。运维改过密码/名称后，
//      重启不会被打回原样；
//   2. **单一实现**：Docker 与 Windows 便携版都跑同一个 server.mjs，所以预置逻辑
//      放在后端而不是启动器或 entrypoint 里，避免两份实现漂移；
//   3. **密码明文落到账号文件**：不使用 `$${default_password}` 变量，否则同一实例
//      下所有账号共享一个可被全局改写的口令，且 `xml_locate directory` 读不出明文；
//   4. **清理但保守**：随包演示账号只在「仍与出厂模板逐字一致」时才移除，
//      一旦被改动过（改密码/改名称）就视为在用，原样保留。

import { readdirSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 默认号段起始（含）。 */
export const DEFAULT_SIP_RANGE_START = 8001;
/** 默认号段结束（含）。数量即 end - start + 1 = 20 个。 */
export const DEFAULT_SIP_RANGE_END = 8020;
/** 默认鉴权密码。9 位、含大小写与符号，满足账号存储的 6-128 位要求。 */
export const DEFAULT_SIP_PASSWORD = "Sip@admin";
/** 默认账号名称前缀，最终形如「广播终端 8001」。 */
export const DEFAULT_SIP_NAME_PREFIX = "广播终端";

/**
 * 随包 FreeSWITCH 演示账号。这些号码出现在官方示例拨号方案与文档里，
 * 属于「教科书示例」，默认全部清理。
 *
 * 数字型演示分机 1000~1019 由 1000.xml ~ 1019.xml 定义；
 * 另外两个是非数字示例（brian 带 192.0.2.0/24 的演示 CIDR，
 * skinny-example 是 SCCP 话机示例）。
 *
 * 注意：`default.xml`（id=default）与 `example.com.xml`（外线网关示例）
 * 不在清理范围内——前者是 FreeSWITCH 目录结构的一部分，后者是无害的
 * 网关占位，两者都与「可注册分机」无关。
 */
export const VANILLA_DEMO_ACCOUNTS = [
  ...Array.from({ length: 20 }, (_, index) => String(1000 + index)),
  "brian",
  "skinny-example",
];

/**
 * 把号段展开成账号规格列表。
 *
 * @param {{start?: number, end?: number, password?: string, namePrefix?: string}} options
 * @returns {Array<{account: string, name: string, displayNumber: string, password: string}>}
 */
export function defaultAccountSpecs({
  start = DEFAULT_SIP_RANGE_START,
  end = DEFAULT_SIP_RANGE_END,
  password = DEFAULT_SIP_PASSWORD,
  namePrefix = DEFAULT_SIP_NAME_PREFIX,
} = {}) {
  const from = Number(start);
  const to = Number(end);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
    throw Object.assign(new Error(`invalid SIP number range: ${start}-${end}`), { status: 500 });
  }
  const specs = [];
  for (let number = from; number <= to; number += 1) {
    const account = String(number);
    specs.push({ account, name: `${namePrefix} ${account}`, displayNumber: account, password });
  }
  return specs;
}

/**
 * 判断一份目录账号文件是否「仍是出厂模板」。
 *
 * 判据是两处模板指纹同时成立：
 *   - 密码仍是 `$${default_password}` 变量（说明没人改过密码）；
 *   - 名称仍是 `Extension <账号>`（说明没人改过名称）。
 *
 * 只要有一处被改过，就认为该账号已在用，不能删。
 *
 * @param {string} account 账号（文件名去掉 .xml）
 * @param {string} document 文件内容
 */
export function isPristineVanillaAccount(account, document) {
  const text = String(document ?? "");
  const hasVariablePassword = /<param\s+name="password"\s+value="\$\$\{default_password\}"\s*\/>/.test(text);
  if (!hasVariablePassword) return false;

  // 数字演示分机额外要求名称未被改动，避免误删「已改名但没改密码」的账号。
  if (/^\d+$/.test(account)) {
    const escaped = account.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`<variable\\s+name="effective_caller_id_name"\\s+value="Extension ${escaped}"\\s*/>`).test(text);
  }

  // 非数字演示账号（brian / skinny-example）以 id 匹配为准。
  if (account === "skinny-example") return /<user\s+id="SEP001120AABBCC"/.test(text);
  return new RegExp(`<user\\s+id="${account}"`).test(text);
}

/**
 * 清理随包演示账号。
 *
 * 只在文件仍是出厂模板时移除，并先把原件移到 `pruned/` 备份目录，
 * 保证可回溯。返回被清理的账号列表。
 *
 * 备份目录刻意放在 sipDirectory 的**子目录**里：FreeSWITCH 用
 * `<X-PRE-PROCESS cmd="include" data="default/*.xml"/>` 加载账号，
 * 该 glob 不递归子目录，因此备份不会被当成账号重新载入。
 *
 * @param {{directory: string, file: (account: string) => string}} store
 * @param {string[]} [accounts]
 */
export function pruneVanillaAccounts(store, accounts = VANILLA_DEMO_ACCOUNTS) {
  const backupDirectory = join(store.directory, "pruned");
  const pruned = [];

  for (const account of accounts) {
    const path = store.file(account);
    let document;
    try {
      document = readFileSync(path, "utf8");
    } catch {
      continue; // 不存在即已清理或从未存在
    }
    if (!isPristineVanillaAccount(account, document)) continue;

    try {
      mkdirSync(backupDirectory, { recursive: true });
      renameSync(path, join(backupDirectory, `${account}.xml`));
      pruned.push(account);
    } catch {
      // 备份或移动失败时保持原样，宁可留下账号也不要造成不可恢复的丢失
    }
  }

  return pruned;
}

/**
 * 补齐默认号段账号。已存在的账号原样保留。
 *
 * @param {{exists: (account: string) => boolean, create: (input: object) => object}} store
 * @param {object} [options] 透传给 {@link defaultAccountSpecs}
 */
export function ensureDefaultAccounts(store, options = {}) {
  const specs = defaultAccountSpecs(options);
  const missing = specs.filter((spec) => !store.exists(spec.account));
  if (!missing.length) return { created: [], existing: specs.map((spec) => spec.account) };

  const created = store.createMany(missing);
  return {
    created: created.map((item) => item.account),
    existing: specs.filter((spec) => !missing.includes(spec)).map((spec) => spec.account),
  };
}

/**
 * 启动时的完整预置流程：先补齐 8XXX 账号，再清理随包演示账号。
 *
 * 顺序很关键：先建新账号再删旧账号，任何一步失败都不会出现
 * 「旧账号已被删除、新账号还没建好」的空窗。
 *
 * 返回 `{ created, existing, pruned }`，`created` 或 `pruned` 非空时
 * 调用方需要执行 reloadxml 让改动生效。
 *
 * @param {object} store SipAccountStore 实例
 * @param {{range?: object, prune?: boolean, pruneAll?: boolean}} [options]
 */
export function provisionDefaultAccounts(store, { range = {}, prune = true } = {}) {
  const ensured = ensureDefaultAccounts(store, range);
  const pruned = prune ? pruneVanillaAccounts(store) : [];
  return { ...ensured, pruned };
}
