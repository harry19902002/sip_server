import assert from "node:assert/strict";
import test from "node:test";
import { sipAccountRegistry } from "../lib/sip-account-registry.mjs";

test("deduplicates FreeSWITCH directory users and merges registrations", () => {
  const users = "userid|context|domain|group|contact|callgroup|effective_caller_id_name|effective_caller_id_number\n1000|default|sip.local|default|error/user_not_registered||Extension 1000|1000\n1000|default|sip.local|sales|error/user_not_registered||Extension 1000|1000\ndefault||sip.local|default||||\n+OK\n";
  const registrations = JSON.stringify({ rows: [{ reg_user: "1000", network_proto: "udp", url: "sip:1000@10.0.0.8:5060" }] });
  const directory = '<domain name="sip.local"><user id="1000"><params><param name="password" value="Clear&amp;Safe123"/></params></user></domain>';
  const result = sipAccountRegistry(users, registrations, directory, new Date("2026-08-30T00:00:00Z"));
  assert.equal(result.count, 1);
  assert.equal(result.items[0].account, "1000");
  assert.equal(result.items[0].department, "default");
  assert.equal(result.items[0].registration, "在线");
  assert.equal(result.items[0].transport, "UDP");
  assert.equal(result.items[0].password, "Clear&Safe123");
});
