import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZoneStore } from "../lib/zone-store.mjs";

test("persists real zones and exclusive terminal assignments", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zone-store-test-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "zones.json"); const store = new ZoneStore(file);
  const first = store.create({ name: "教学楼" }); const second = store.create({ name: "操场" });
  store.assign(first.id, ["8000@sip.local"]); store.assign(second.id, ["8000@sip.local"]);
  assert.deepEqual(store.list().find((zone) => zone.id === first.id).terminalIds, []);
  assert.equal(store.terminalZones()["8000@sip.local"], "操场");
  assert.equal(new ZoneStore(file).rename(second.id, { name: "体育场" }).name, "体育场");
  assert.equal(store.delete(first.id).name, "教学楼");
});
