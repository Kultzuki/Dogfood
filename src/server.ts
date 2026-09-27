import { buildApp } from "./app.js";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3000);

const app = await buildApp({ logger: true });

try {
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`Server listening on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err, "Failed to start server");
  process.exit(1);
}

const shutdown = async () => {
  app.log.info("Shutting down…");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
