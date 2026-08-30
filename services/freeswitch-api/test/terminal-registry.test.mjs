import assert from "node:assert/strict";
import test from "node:test";
import { terminalRegistry } from "../lib/terminal-registry.mjs";

test("maps live FreeSWITCH registrations and active channels to terminals", () => {
  const registrations = JSON.stringify({ rows: [{ reg_user: "81001", realm: "sip.local", network_ip: "10.20.1.31", network_port: "5060", network_proto: "udp", url: "sip:81001@10.20.1.31:5060" }] });
  const channels = JSON.stringify({ rows: [{ name: "sofia/internal/81001@sip.local" }] });
  const result = terminalRegistry(registrations, channels, { "81001@sip.local": "一层走廊音箱" }, { "81001@sip.local": "教学楼" }, new Date("2026-08-30T00:00:00Z"));
  assert.equal(result.count, 1);
  assert.deepEqual(result.items[0], {
    id: "81001@sip.local", name: "一层走廊音箱", extension: "81001", zone: "教学楼", location: "10.20.1.31:5060", ip: "10.20.1.31", port: "5060", transport: "UDP", contact: "sip:81001@10.20.1.31:5060", type: "SIP 终端", status: "播放中", last: "当前已注册", capability: "广播", priority: 0,
  });
});

test("returns an empty terminal list when FreeSWITCH has no registrations", () => {
  assert.deepEqual(terminalRegistry('{"row_count":0}', '{"row_count":0}', {}, {}).items, []);
});
