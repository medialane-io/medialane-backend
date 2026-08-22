import { serve } from "@hono/node-server";
import { createApp } from "./api/server.js";
import { startMirror } from "./mirror/index.js";
import { registerIngestors, type ChainIngestor } from "./mirror/ingestor.js";
import { startOrchestrator } from "./orchestrator/index.js";
import { worker } from "./orchestrator/worker.js";
import { env } from "./config/env.js";
import { createLogger } from "./utils/logger.js";
import prisma from "./db/client.js";

const log = createLogger("main");

async function main() {
  log.info({ chain: "STARKNET", port: env.PORT }, "Starting Medialane Backend");

  if (!env.PINATA_JWT) {
    log.warn("PINATA_JWT is not set — metadata uploads and IPFS pinning will fail");
  }

  try {
    await prisma.$connect();
    log.info("Database connected");
  } catch (err) {
    log.fatal({ err }, "Database connection failed");
    process.exit(1);
  }

  const app = createApp();

  serve(
    { fetch: app.fetch, port: env.PORT },
    (info) => {
      log.info({ port: info.port }, `HTTP server listening`);
    }
  );

  const starknetIngestor: ChainIngestor = {
    chain: "STARKNET",
    start: () =>
      startMirror().catch((err) => {
        log.fatal({ err }, "Mirror crashed");
        process.exit(1);
      }),
  };
  registerIngestors([starknetIngestor]);

  startOrchestrator().catch((err) => {
    log.fatal({ err }, "Orchestrator crashed");
    process.exit(1);
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function shutdown() {
  log.info("Shutting down Medialane...");

  await worker.waitDrain(10_000);
  await prisma.$disconnect();
  process.exit(0);
}

main();
