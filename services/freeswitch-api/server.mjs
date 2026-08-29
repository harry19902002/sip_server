import { createServer } from "node:http";
import { BroadcastService } from "./lib/broadcast-service.mjs";
import { EslClient } from "./lib/esl-client.mjs";
import { createRequestHandler } from "./lib/http-app.mjs";

const config = {
  port: Number(process.env.PORT ?? 3001),
  apiKey: process.env.API_KEY ?? "",
  domain: process.env.FREESWITCH_DOMAIN ?? "sip.local",
  taskStorePath: process.env.TASK_STORE_PATH ?? "",
  esl: {
    host: process.env.ESL_HOST ?? "127.0.0.1",
    port: Number(process.env.ESL_PORT ?? 8021),
    password: process.env.ESL_PASSWORD ?? "",
    timeoutMs: Number(process.env.ESL_TIMEOUT_MS ?? 5000),
  },
};

if (!config.apiKey || !config.esl.password) throw new Error("API_KEY and ESL_PASSWORD are required");

const esl = new EslClient(config.esl);
const broadcasts = new BroadcastService({ esl, domain: config.domain, storePath: config.taskStorePath });
await broadcasts.initialize();

const server = createServer(createRequestHandler({ apiKey: config.apiKey, esl, broadcasts }));
server.listen(config.port, "0.0.0.0", () => console.log(`FreeSWITCH API listening on port ${config.port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
