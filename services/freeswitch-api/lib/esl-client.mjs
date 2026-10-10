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

export class EslEventSubscriber {
  constructor({ host, port = 8021, password, reconnectMs = 2000 }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.reconnectMs = reconnectMs;
    this.stopped = true;
    this.socket = null;
    this.timer = null;
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

    const reconnect = (error) => {
      if (this.stopped) return;
      this.onState({ connected: false, error: error?.message ?? "ESL event connection closed" });
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
      this.onState({ connected: true });

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
