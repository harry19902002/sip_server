import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BroadcastService } from "../lib/broadcast-service.mjs";

function fakeEsl({ failTarget } = {}) {
  const commands = [];
  return {
    commands,
    async execute(command, options = {}) {
      commands.push({ command, options });
      if (failTarget && command.includes(`user/${failTarget}@`)) throw new Error("destination unavailable");
      return { body: "+OK", jobUuid: `job-${commands.length}` };
    },
  };
}

test("creates, persists and cancels a broadcast task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "broadcast-service-"));
  const storePath = join(directory, "tasks.json");
  const esl = fakeEsl();
  const service = new BroadcastService({ esl, domain: "sip.local", storePath });

  const task = await service.createTask({ name: "测试广播", mediaId: "test-tone", targets: ["81001", "81001", "81002"] });
  assert.equal(task.status, "accepted");
  assert.equal(task.targets.length, 2);
  assert.equal(esl.commands[0].options.background, true);
  assert.match(esl.commands[0].command, /tone_stream/);

  const cancelled = await service.cancelTask(task.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.targets[0].status, "cancelled");
  const stored = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(stored.tasks[0].id, task.id);
});

test("records a partial dispatch without rejecting the whole task", async () => {
  const service = new BroadcastService({ esl: fakeEsl({ failTarget: "81002" }) });
  const task = await service.createTask({ mediaId: "safety-tone", targets: ["81001", "81002"] });
  assert.equal(task.status, "partial");
  assert.deepEqual(task.targets.map((target) => target.status), ["accepted", "failed"]);
});

test("rejects unknown media and invalid extensions", async () => {
  const service = new BroadcastService({ esl: fakeEsl() });
  await assert.rejects(() => service.createTask({ mediaId: "missing", targets: ["81001"] }), /mediaId/);
  await assert.rejects(() => service.createTask({ mediaId: "test-tone", targets: ["8;reloadxml"] }), /numeric SIP extensions/);
});
