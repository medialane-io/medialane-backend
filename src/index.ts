import { serve } from "@hono/node-server";
import { createApp } from "./api/server.js";
import { startMirror } from "./mirror/index.js";
import { startOrchestrator } from "./orchestrator/index.js";
import { env } from "./config/env.js";
import { createLogger } from "./utils/logger.js";
import prisma from "./db/client.js";

const log = createLogger("main");

async function main() {
  log.info({ network: env.STARKNET_NETWORK, port: env.PORT }, "Starting Medialane Backend");

  // Verify DB connection
  try {
    await prisma.$connect();
    log.info("Database connected");
  } catch (err) {
    log.fatal({ err }, "Database connection failed");
    process.exit(1);
  }

  // Start background services concurrently
  const app = createApp();

  // Start HTTP server
  serve(
    { fetch: app.fetch, port: env.PORT },
    (info) => {
      log.info({ port: info.port }, `HTTP server listening`);
    }
  );

  // Start Mirror and Orchestrator in background (non-blocking)
  startMirror().catch((err) => {
    log.fatal({ err }, "Mirror crashed");
    process.exit(1);
  });

  startOrchestrator().catch((err) => {
    log.fatal({ err }, "Orchestrator crashed");
    process.exit(1);
  });

  // Graceful shutdown
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function shutdown() {
  log.info("Shutting down Medialane...");
  await prisma.$disconnect();
  process.exit(0);
}

main();
