import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const mediaCatalog = [
  { id: "safety-tone", name: "校园安全提示音", duration: "4 秒", category: "安全提示", playback: "tone_stream://%(350,150,880);loops=8" },
  { id: "attention-tone", name: "临时通知前奏", duration: "3 秒", category: "提示音", playback: "tone_stream://%(200,100,660,880);loops=10" },
  { id: "test-tone", name: "SIP 线路测试音", duration: "2 秒", category: "系统测试", playback: "tone_stream://%(200,200,425);loops=5" },
];

const extensionPattern = /^[0-9]{2,12}$/;
const audioPathPattern = /^\/(?:usr\/share\/freeswitch\/sounds|var\/lib\/freeswitch\/(?:storage|recordings))\/[a-zA-Z0-9_./-]+\.(?:wav|mp3)$/;

function requestError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function publicMedia(media) {
  return { id: media.id, name: media.name, duration: media.duration, category: media.category };
}

export class BroadcastService {
  constructor({ esl, domain = "sip.local", storePath = "" }) {
    this.esl = esl;
    this.domain = domain;
    this.storePath = storePath;
    this.tasks = [];
    this.persistQueue = Promise.resolve();
  }

  async initialize() {
    if (!this.storePath) return;
    try {
      const stored = JSON.parse(await readFile(this.storePath, "utf8"));
      this.tasks = Array.isArray(stored.tasks) ? stored.tasks : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  listMedia() {
    return mediaCatalog.map(publicMedia);
  }

  listTasks(limit = 50) {
    return this.tasks.slice(0, Math.min(Math.max(limit, 1), 200));
  }

  getTask(id) {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw requestError("broadcast task not found", 404);
    return task;
  }

  async createTask(input) {
    const targets = Array.isArray(input.targets) ? [...new Set(input.targets.map(String))] : [];
    const callerId = String(input.callerId ?? "9999");
    const media = mediaCatalog.find((item) => item.id === input.mediaId);
    const rawAudio = String(input.audio ?? "");

    if (!targets.length || targets.length > 500 || targets.some((target) => !extensionPattern.test(target))) {
      throw requestError("targets must contain 1-500 numeric SIP extensions");
    }
    if (!extensionPattern.test(callerId)) throw requestError("callerId must be numeric");
    if (!media && !audioPathPattern.test(rawAudio)) throw requestError("mediaId must reference an available media item");

    const now = new Date().toISOString();
    const task = {
      id: `JOB-${now.slice(2, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: String(input.name ?? "实时广播").trim().slice(0, 80) || "实时广播",
      type: "realtime",
      status: "dispatching",
      media: media ? publicMedia(media) : { id: "uploaded-file", name: rawAudio.split("/").at(-1), category: "媒体文件" },
      callerId,
      createdAt: now,
      updatedAt: now,
      targets: targets.map((extension) => ({ extension, status: "queued", channelUuid: null, jobUuid: null, error: null })),
    };
    this.tasks.unshift(task);
    await this.persist();

    for (const target of task.targets) {
      target.channelUuid = randomUUID();
      const dialString = `{origination_uuid=${target.channelUuid},origination_caller_id_number=${callerId},ignore_early_media=true}user/${target.extension}@${this.domain}`;
      try {
        const result = await this.esl.execute(`originate ${dialString} &playback(${media?.playback ?? rawAudio})`, { background: true });
        target.jobUuid = result.jobUuid;
        target.status = "accepted";
      } catch (error) {
        target.status = "failed";
        target.error = error.message;
      }
    }

    const accepted = task.targets.filter((target) => target.status === "accepted").length;
    task.status = accepted === task.targets.length ? "accepted" : accepted ? "partial" : "failed";
    task.updatedAt = new Date().toISOString();
    await this.persist();
    return task;
  }

  async cancelTask(id) {
    const task = this.getTask(id);
    if (["cancelled", "failed"].includes(task.status)) return task;
    for (const target of task.targets.filter((item) => item.status === "accepted")) {
      try {
        await this.esl.execute(`uuid_kill ${target.channelUuid} NORMAL_CLEARING`);
      } catch {
        // The call may already have ended; cancellation remains idempotent.
      }
      target.status = "cancelled";
    }
    task.status = "cancelled";
    task.updatedAt = new Date().toISOString();
    task.cancelledAt = task.updatedAt;
    await this.persist();
    return task;
  }

  async persist() {
    if (!this.storePath) return;
    const serialized = JSON.stringify({ version: 1, tasks: this.tasks }, null, 2);
    this.persistQueue = this.persistQueue.then(async () => {
      await mkdir(dirname(this.storePath), { recursive: true });
      const temporaryPath = `${this.storePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.storePath);
    });
    return this.persistQueue;
  }
}
