import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalMetadataStore } from "../lib/terminal-metadata-store.mjs";

test("persists custom terminal names", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "terminal-metadata-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "terminals.json");
  const store = new TerminalMetadataStore(file);
  assert.deepEqual(store.rename("8000@sip.local", { name: "东门音箱" }), { id: "8000@sip.local", name: "东门音箱" });
  assert.equal(new TerminalMetadataStore(file).listNames()["8000@sip.local"], "东门音箱");
  assert.throws(() => store.rename("8000@sip.local", { name: "" }), /1-80/);
});
