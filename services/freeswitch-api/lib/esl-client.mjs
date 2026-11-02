import net from "node:net";

export function parseEslFrames(input) {
  let buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const frames = [];

  while (buffer.length) {
    const crlfBoundary = buffer.indexOf("\r\n\r\n");
    const lfBoundary = buffer.indexOf("\n\n");
    let headerEnd = -1;
    let separatorLength = 0;

    if (crlfBoundary >= 0 && (lfBoundary < 0 || crlfBoundary < lfBoundary)) {
      headerEnd = crlfBoundary;
      separatorLength = 4;
    } else if (lfBoundary >= 0) {
      headerEnd = lfBoundary;
      separatorLength = 2;
    }

    if (headerEnd < 0) break;

    const headerText = buffer.subarray(0, headerEnd).toString("utf8");
    const headers = {};
    for (const line of headerText.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim().toLowerCase();
      headers[key] = decodeURIComponent(line.slice(separator + 1).trim());
    }

    const contentLength = Number(headers["content-length"] ?? 0);
    const frameLength = headerEnd + separatorLength + contentLength;
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new Error("Invalid ESL Content-Length");
    }
    if (buffer.length < frameLength) break;

    const bodyStart = headerEnd + separatorLength;
    frames.push({
      headers,
      body: buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8"),
    });
    buffer = buffer.subarray(frameLength);
  }

  return { frames, remainder: buffer };
}

function createFrameReader(socket) {
  let buffer = Buffer.alloc(0);
  const queued = [];
  const waiters = [];
  let terminalError;

  const deliver = (frame) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(frame);
    else queued.push(frame);
  };

  const fail = (error) => {
    terminalError = error;
    while (waiters.length) waiters.shift().reject(error);
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      const parsed = parseEslFrames(buffer);
      buffer = parsed.remainder;
      parsed.frames.forEach(deliver);
    } catch (error) {
      fail(error);
      socket.destroy();
    }
  });
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("ESL connection closed")));

  return () => {
    if (queued.length) return Promise.resolve(queued.shift());
    if (terminalError) return Promise.reject(terminalError);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
}

export class EslClient {
  constructor({ host, port = 8021, password, timeoutMs = 5000 }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.timeoutMs = timeoutMs;
  }

  async execute(command, { background = false } = {}) {
    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.setTimeout(this.timeoutMs);
    const nextFrame = createFrameReader(socket);

    socket.on("timeout", () => socket.destroy(new Error("ESL request timed out")));

    try {
      const challenge = await nextFrame();
      if (challenge.headers["content-type"] !== "auth/request") {
        throw new Error("FreeSWITCH did not request ESL authentication");
      }

      socket.write(`auth ${this.password}\n\n`);
      const authentication = await nextFrame();
      if (!authentication.headers["reply-text"]?.startsWith("+OK")) {
        throw new Error("FreeSWITCH ESL authentication failed");
      }

      socket.write(`${background ? "bgapi" : "api"} ${command}\n\n`);
      const response = await nextFrame();
      const replyText = response.headers["reply-text"] ?? "";
      if (replyText.startsWith("-ERR") || response.body.startsWith("-ERR")) {
        throw new Error(replyText || response.body.trim());
      }

      return {
        body: response.body.trim(),
        jobUuid: response.headers["job-uuid"] ?? replyText.match(/Job-UUID:\s*([^\s]+)/i)?.[1] ?? null,
        replyText,
      };
    } catch (error) {
      error.status ??= 502;
      throw error;
    } finally {
      socket.end();
    }
  }
}

// 断连状态的播报节流窗口（毫秒）。
//
// 背景：FreeSWITCH 若长期不在线，原来的实现每 2 秒重连一次，且单次失败会因
// error/close/catch 三处回调各播报一次 —— 实测把 api.log 刷了 4582 行
// （约 0.6 MB），既淹没有效日志，也掩盖了真正的故障时间点。
//
// 现在的策略：只在「状态发生变化」时播报；持续断开期间每 60 秒提醒一次，
// 这样既能第一时间暴露故障，又不会刷屏。
const ESL_REPORT_REMINDER_MS = 60_000;

export class EslEventSubscriber {
  constructor({ host, port = 8021, password, reconnectMs = 2000 }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.reconnectMs = reconnectMs;
    this.stopped = true;
    this.socket = null;
    this.timer = null;
    // 节流用：当前是否已断开、上次播报断开/恢复的时间、本次断连累计重试次数
    this.disconnected = null;
    this.lastReportAt = 0;
    this.attempts = 0;
  }

  /**
   * 按「状态变化才播报」的规则上报连接状态。
   * 持续断开时每 ESL_REPORT_REMINDER_MS 提醒一次，避免刷屏（见常量注释）。
   */
  reportState(state) {
    const now = Date.now();
    const connected = state.connected === true;
    const changed = this.disconnected === null || this.disconnected !== !connected;
    if (changed) {
      this.lastReportAt = now;
      this.disconnected = !connected;
      if (connected) this.attempts = 0;
      this.onState(state);
      return;
    }
    if (connected) return; // 一直连着：不重复播报
    if (now - this.lastReportAt >= ESL_REPORT_REMINDER_MS) {
      this.lastReportAt = now;
      this.onState({ ...state, reminder: true, attempts: this.attempts });
    }
  }

  start(onEvent, onState = () => {}) {
    this.stopped = false;
    this.onEvent = onEvent;
    this.onState = onState;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
  }

  async connect() {
    if (this.stopped) return;
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    const nextFrame = createFrameReader(socket);
    let authenticated = false;
    // error/close/catch 三处都可能触发重连，用一次性闭包内的标记去重，
    // 否则同一次失败会重复上报并重复排定定时器。
    let reconnected = false;

    const reconnect = (error) => {
      if (this.stopped || reconnected) return;
      reconnected = true;
      this.attempts += 1;
      this.reportState({
        connected: false,
        error: error?.message ?? "ESL event connection closed",
        attempts: this.attempts,
      });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.connect(), this.reconnectMs);
    };

    socket.once("error", reconnect);
    socket.once("close", () => reconnect());

    try {
      const challenge = await nextFrame();
      if (challenge.headers["content-type"] !== "auth/request") throw new Error("FreeSWITCH did not request ESL authentication");
      socket.write(`auth ${this.password}\n\n`);
      const authentication = await nextFrame();
      if (!authentication.headers["reply-text"]?.startsWith("+OK")) throw new Error("FreeSWITCH ESL event authentication failed");
      authenticated = true;
      socket.write("event json BACKGROUND_JOB CHANNEL_ANSWER CHANNEL_PARK CHANNEL_HANGUP_COMPLETE CUSTOM sofia::register sofia::unregister\n\n");
      const subscription = await nextFrame();
      if (!subscription.headers["reply-text"]?.startsWith("+OK")) throw new Error("FreeSWITCH rejected ESL event subscription");
      this.reportState({ connected: true });

      while (!this.stopped && !socket.destroyed) {
        const frame = await nextFrame();
        if (frame.headers["content-type"] !== "text/event-json") continue;
        try {
          this.onEvent(JSON.parse(frame.body));
        } catch (error) {
          this.onState({ connected: true, error: `Invalid ESL event: ${error.message}` });
        }
      }
    } catch (error) {
      if (!authenticated || !socket.destroyed) socket.destroy();
      reconnect(error);
    }
  }
}
