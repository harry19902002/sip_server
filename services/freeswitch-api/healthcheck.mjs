import http from "node:http";

const port = Number(process.env.PORT ?? 3001);
const request = http.get(
  { hostname: "127.0.0.1", port, path: "/health", timeout: 3000 },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);

request.on("timeout", () => request.destroy(new Error("health check timeout")));
request.on("error", () => process.exit(1));
