import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZoneStore, ZONE_NUMBER_MAX, ZONE_NUMBER_MIN } from "../lib/zone-store.mjs";
import { buildZonePagingDialplan } from "../lib/zone-dialplan.mjs";

// 号段为 6xxxx（5 位）。实测随包 dialplan 的 6 开头规则只有 4 位的 6000 与 60xx
// （default.xml 第 549/561 行），与 5 位不重叠；黑名单机制保留以备将来。
const RESERVED_FOR_TEST = new Set([]);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "sip-zone-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new ZoneStore(join(directory, "zones.json"));
}

test("auto-assigns a 6xxxx number on create", (t) => {
  const store = fixture(t);
  const zone = store.create({ name: "行政楼" });
  assert.match(zone.number, /^6\d{4}$/);
  assert.ok(Number(zone.number) >= ZONE_NUMBER_MIN);
  assert.ok(Number(zone.number) <= ZONE_NUMBER_MAX);
  assert.equal(zone.number, String(ZONE_NUMBER_MIN));
});

test("assigns distinct numbers to successive zones", (t) => {
  const store = fixture(t);
  const numbers = ["A", "B", "C"].map((name) => store.create({ name }).number);
  assert.equal(new Set(numbers).size, 3, `numbers collided: ${numbers.join(",")}`);
});

test("accepts an explicit number in range", (t) => {
  const store = fixture(t);
  const zone = store.create({ name: "体育馆", number: "65271" });
  assert.equal(zone.number, "65271");
});

test("rejects numbers outside the 6xxxx segment", (t) => {
  const store = fixture(t);
  // 1000/9100 都是旧号段或个人分机号段，必须拒绝
  assert.throws(() => store.create({ name: "X", number: "1000" }), /5 位数字/);
  assert.throws(() => store.create({ name: "X", number: "9100" }), /5 位数字/);
  assert.throws(() => store.create({ name: "X", number: "1234" }), /5 位数字/);
  assert.throws(() => store.create({ name: "X", number: "10000" }), /60000-69999/);
  assert.throws(() => store.create({ name: "X", number: "70000" }), /60000-69999/);
  assert.throws(() => store.create({ name: "X", number: "abcde" }), /5 位数字/);
});

test("5-digit zone numbers do not collide with the 4-digit 60xx sample numbers", (t) => {
  const store = fixture(t);
  // 样例 default.xml 用 4 位的 6000 / 60xx；本功能用 5 位，二者是不同的号码。
  const zone = store.create({ name: "边界", number: "60000" });
  assert.equal(zone.number, "60000");
  assert.notEqual(zone.number, "6000");
});

test("rejects a number already used by another zone", (t) => {
  const store = fixture(t);
  store.create({ name: "A", number: "62000" });
  assert.throws(() => store.create({ name: "B", number: "62000" }), /已被分区/);
});

test("auto-assignment skips numbers already taken", (t) => {
  const store = fixture(t);
  store.create({ name: "A", number: String(ZONE_NUMBER_MIN) });
  store.create({ name: "B", number: String(ZONE_NUMBER_MIN + 1) });
  const third = store.create({ name: "C" });
  assert.equal(third.number, String(ZONE_NUMBER_MIN + 2));
});

test("auto-assignment never lands on a reserved number", (t) => {
  const store = fixture(t);
  const assigned = [];
  for (let index = 0; index < 15; index += 1) assigned.push(store.create({ name: `Z${index}` }).number);
  for (const number of assigned) {
    assert.ok(!RESERVED_FOR_TEST.has(number), `自动分配落到了冲突号码 ${number}`);
  }
  assert.equal(new Set(assigned).size, assigned.length);
});

test("update can change the number and keeps uniqueness", (t) => {
  const store = fixture(t);
  const a = store.create({ name: "A", number: "62000" });
  store.create({ name: "B", number: "62001" });

  const updated = store.update(a.id, { number: "63000" });
  assert.equal(updated.number, "63000");
  assert.equal(updated.name, "A");

  // 改成别人已占用的号码必须被拒
  assert.throws(() => store.update(a.id, { number: "62001" }), /已被分区/);
  // 改成自己当前的号码是允许的（幂等）
  assert.equal(store.update(a.id, { number: "63000" }).number, "63000");
});

test("backfills numbers for zones created before this feature", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sip-zone-legacy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "zones.json");
  // 模拟早期数据：没有 number 字段
  writeFileSync(file, JSON.stringify({ zones: [{ id: "z1", name: "旧分区", createdAt: "2026-01-01" }], assignments: {} }), "utf8");

  const store = new ZoneStore(file);
  const zone = store.list()[0];
  assert.equal(zone.name, "旧分区");
  assert.match(zone.number, /^6\d{4}$/, "存量分区应被自动补号，否则拨打分区号群呼对它不可用");
});

test("migrates numbers left over from the old 9xxx segment", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sip-zone-migrate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "zones.json");
  // 模拟旧号段数据：9100（9xxx 时代分配，且与随包样例 dialplan 冲突）
  writeFileSync(file, JSON.stringify({
    zones: [{ id: "z1", name: "分区1", number: "9100", createdAt: "2026-09-11" }],
    assignments: { "1000@sip.local": "z1" },
  }), "utf8");

  const store = new ZoneStore(file);
  const zone = store.list()[0];
  assert.match(zone.number, /^6\d{4}$/, `旧号段必须迁移到 6xxxx，实际=${zone.number}`);
  assert.equal(zone.previousNumber, "9100", "应保留原号码以便追溯");
  // 成员归属不能丢
  assert.deepEqual(zone.terminalIds, ["1000@sip.local"]);
});

test("does not churn numbers that are already in the current segment", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sip-zone-stable-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "zones.json");
  writeFileSync(file, JSON.stringify({
    zones: [{ id: "z1", name: "已迁移", number: "60123", createdAt: "2026-09-14" }],
    assignments: {},
  }), "utf8");

  const store = new ZoneStore(file);
  assert.equal(store.list()[0].number, "60123", "已是当前号段的号码不应被重新分配");
});

test("dialplanZones maps number to the zone extensions", (t) => {
  const store = fixture(t);
  const zone = store.create({ name: "行政楼", number: "60000" });
  store.assign(zone.id, ["1000@sip.local", "1001@sip.local"]);
  store.create({ name: "空分区", number: "60001" }); // 无成员

  const rows = store.dialplanZones();
  const target = rows.find((row) => row.number === "60000");
  assert.deepEqual(target.extensions, ["1000", "1001"]);
  assert.equal(target.name, "行政楼");
  assert.ok(rows.every((row) => row.extensions.every((ext) => /^\d+$/.test(ext))));
});

test("generated dialplan pages every member and mutes terminals", () => {
  const xml = buildZonePagingDialplan(
    [{ number: "60000", name: "行政楼", extensions: ["1000", "1001"] }],
    { domain: "sip.local" },
  );

  // 号码被精确匹配
  assert.match(xml, /expression="\^60000\$"/);
  // 每个成员都有一条自动呼出指令
  assert.match(xml, /conference_set_auto_outcall" data="user\/1000@sip\.local"/);
  assert.match(xml, /conference_set_auto_outcall" data="user\/1001@sip\.local"/);
  // 关键：终端必须静音加入（只听不说），否则广播会啸叫。
  // 必须用 auto_outcall_flags（只作用于被呼出的终端）；
  // 若误用 conference_member_flags，主叫也会被静音，喊话功能直接失效。
  assert.match(xml, /conference_utils_auto_outcall_flags=mute/);
  assert.doesNotMatch(xml, /conference_member_flags/, "不得用 conference_member_flags 静音，否则主叫无法喊话");
  // 进入会议，且会议名带分区号避免串音
  assert.match(xml, /application="conference" data="zone_60000@/);
  // 没有成员的号码不应生成 extension（否则拨了会开一个空会）
  assert.doesNotMatch(xml, /zone_paging_60001/);
});

test("generated dialplan is valid XML and escapes zone names", () => {
  const xml = buildZonePagingDialplan(
    [{ number: "60150", name: 'A&B <测试> "引号"', extensions: ["1000"] }],
    { domain: "sip.local" },
  );
  assert.match(xml, /A&amp;B/);
  assert.doesNotMatch(xml, /<测试>/);
  const opens = (xml.match(/<extension\b/g) || []).length;
  const closes = (xml.match(/<\/extension>/g) || []).length;
  assert.equal(opens, closes, "extension 标签必须成对");
  assert.equal((xml.match(/<include>/g) || []).length, 1);
  assert.equal((xml.match(/<\/include>/g) || []).length, 1);
});

test("does not nest a context element (the include lives inside default context)", () => {
  const xml = buildZonePagingDialplan(
    [{ number: "60150", name: "行政楼", extensions: ["1000"] }],
    { domain: "sip.local" },
  );
  assert.doesNotMatch(xml, /<context\b/, "不得再包一层 <context>");
  assert.doesNotMatch(xml, /<\/context>/);
});

test("empty zone list still produces a loadable (memberless) dialplan", () => {
  const xml = buildZonePagingDialplan([], { domain: "sip.local" });
  assert.match(xml, /<include>/);
  assert.doesNotMatch(xml, /<extension /, "无分区时不应产生任何 extension");
});
