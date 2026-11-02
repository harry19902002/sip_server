// 分区群呼拨号方案生成器。
//
// 需求：拨打「分区的 SIP 号码」即对分区内所有终端发起群呼，实现实时喊话。
//
// 实现方式（全部在 FreeSWITCH 内部完成，不依赖后端进程存活）：
//   1. 生成一份 dialplan，把每个分区号码映射到一个同名会议；
//   2. 对分区内每个在线终端执行 conference_set_auto_outcall，把待呼号码
//      累积到该信道的私有列表里；
//   3. 执行 conference 进入会议 —— 会议启动时会把上述列表里的成员
//      一次性呼出（见 conference_loop.c 的 autocall 处理）。
//
// 为什么让终端「只听不说」：
//   广播场景下如果终端也把环境音送回会议，会形成正反馈啸叫。
//   通过 conference_member_flags=mute 让终端加入时即被静音
//   （mod_conference 的 conference_utils_set_mflags 会把 CAN_SPEAK 置 0，
//    并在加入时直接 hard_mute），从根上避免啸叫。
//
// 生成时机：分区增删改（号码/成员变化）时重新生成。dialplan 目录下任意
// *.xml 会被 freeswitch.xml 的 <X-PRE-PROCESS cmd="include" data="dialplan/*.xml"/>
// 自动加载，因此改名或删除本文件即可整体撤销该功能。

const FILE_NAME = "90_zone_paging.xml";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * 生成分区群呼 dialplan 内容。
 *
 * 文件结构说明（很关键）：
 *   conf/dialplan/default.xml 里的 include 位于 <context name="default"> **内部**
 *   （见 default.xml 第 14 行开、第 847 行闭，第 796 行是 include），
 *   且随包样例文件（如 default/01_Talking_Clock.xml）都是
 *   `<include><extension>` 这种**不含 context** 的结构。
 *   因此本文件同样只输出 <include><extension>，不能再包一层 <context>，
 *   否则会形成嵌套 context 导致拨号方案解析异常。
 *
 * @param {Array<{number: string, name: string, extensions: string[]}>} zoneList
 * @param {{ domain: string, conferenceProfile?: string }} options
 * @returns {string} XML 文本
 */
export function buildZonePagingDialplan(zoneList, { domain, conferenceProfile = "wideband" } = {}) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push("<!--");
  lines.push("  本文件由业务后端自动生成，请勿手工编辑。");
  lines.push("  拨打分区号码 → 对分区内所有终端发起群呼（实时喊话）。");
  lines.push("  修改分区号码或成员后会自动重新生成。");
  lines.push("  注意：include 位于 default 上下文内部，故此处不再包 context 元素。");
  lines.push("-->");
  lines.push("<include>");

  const usable = (zoneList ?? []).filter((zone) => zone?.number && Array.isArray(zone.extensions) && zone.extensions.length > 0);

  for (const zone of usable) {
    lines.push(`  <!-- 分区「${xmlEscape(zone.name)}」· ${zone.extensions.length} 台终端 -->`);
    lines.push(`  <extension name="zone_paging_${xmlEscape(zone.number)}">`);
    lines.push(`    <condition field="destination_number" expression="^${xmlEscape(zone.number)}$">`);
    lines.push('      <action application="answer"/>');
    lines.push('      <action application="sleep" data="300"/>');
    // 逐个终端累积到自动呼出列表；user/<ext>@<domain> 走本地用户目录。
    for (const extension of zone.extensions) {
      lines.push(
        `      <action application="conference_set_auto_outcall" data="user/${xmlEscape(extension)}@${xmlEscape(domain)}"/>`,
      );
    }
    // 终端成员标志：mute = 加入即静音（只听不说），避免广播啸叫。
    //
    // 这里用 conference_utils_auto_outcall_flags 而非 conference_member_flags：
    // 前者只作用于**被自动呼出的成员**（即分区内终端），
    // 后者会连主叫一起限制 —— 实测两者都会让主叫 can_speak=false，
    // 那样呼入方就无法喊话了，功能会失效。
    // 见 conference_loop.c:1364 读取该变量并传给 conference_outcall_bg。
    lines.push('      <action application="set" data="conference_utils_auto_outcall_flags=mute"/>');
    lines.push('      <action application="set" data="conference_auto_outcall_caller_id_name=ZonePaging"/>');
    lines.push(`      <action application="set" data="conference_auto_outcall_profile=${xmlEscape(conferenceProfile)}"/>`);
    lines.push('      <action application="set" data="conference_auto_outcall_timeout=30"/>');
    lines.push('      <action application="set" data="conference_auto_outcall_maxwait=20"/>');
    // 会议名带上分区号，便于在 fs_cli 里辨认，也避免不同分区互相串音。
    lines.push(`      <action application="conference" data="zone_${xmlEscape(zone.number)}@${xmlEscape(conferenceProfile)}"/>`);
    lines.push('    </condition>');
    lines.push('  </extension>');
  }

  lines.push("</include>");
  lines.push("");
  return lines.join("\n");
}

/**
 * 把 dialplan 写入目标目录（幂等）。
 *
 * @param {import("node:fs")} fs
 * @param {string} directory FreeSWITCH conf/dialplan 目录
 * @param {string} content 已生成的 XML
 * @returns {{ path: string, written: boolean }}
 */
export function writeZonePagingDialplan(fs, directory, content) {
  const path = `${directory}/${FILE_NAME}`;
  fs.mkdirSync(directory, { recursive: true });
  const previous = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null;
  if (previous === content) return { path, written: false };
  const temporary = `${path}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, path);
  return { path, written: true };
}

export const ZONE_PAGING_DIALPLAN_FILE = FILE_NAME;
