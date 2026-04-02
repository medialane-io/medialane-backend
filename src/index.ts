import { serve } from "@hono/node-server";
import { createApp } from "./api/server.js";
import { startMirror } from "./mirror/index.js";
import { startOrchestrator } from "./orchestrator/index.js";
import { worker } from "./orchestrator/worker.js";
import { env } from "./config/env.js";
import { createLogger } from "./utils/logger.js";
import prisma from "./db/client.js";

const log = createLogger("main");

async function main() {
  log.info({ network: env.STARKNET_NETWORK, port: env.PORT }, "Starting Medialane Backend");

  // Warn about optional-but-important env vars that have empty defaults
  if (!env.PINATA_JWT) {
    log.warn("PINATA_JWT is not set — metadata uploads and IPFS pinning will fail");
  }

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

  if (env.INDEXER_ENABLED) {
    startMirror().catch((err) => {
      log.fatal({ err }, "Mirror crashed");
      process.exit(1);
    });
  } else {
    log.warn(
      "INDEXER_ENABLED=false — Starknet mirror is off (no background RPC polling). New on-chain data will not be indexed until you re-enable it or run a backfill."
    );
  }

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
  // Drain the in-memory worker queue before exiting so in-flight metadata/stats
  // jobs are not abandoned mid-execution. Give it up to 10 seconds.
  await worker.waitDrain(10_000);
  await prisma.$disconnect();
  process.exit(0);
}

main();
