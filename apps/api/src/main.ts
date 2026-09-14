import { readConfig } from "./config.js";
import { createHttpServer } from "./server.js";

const config = readConfig();
const { server } = createHttpServer(config);

server.listen(config.port, config.host, () => {
  console.log(`LifeOS API listening on http://${config.host}:${config.port}`);
});

function shutdown(signal: string): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
  console.log(`LifeOS API shutting down (${signal})`);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
