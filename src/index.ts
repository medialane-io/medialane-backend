import { serve } from "@hono/node-server";
import { createApp } from "./api/server.js";
import { worker } from "./orchestrator/worker.js";
import { env } from "./config/env.js";
import { createLogger } from "./utils/logger.js";
import prisma from "./db/client.js";

const log = createLogger("main");

// The block indexer (mirror) and the background orchestrator loops (reaper,
// webhook delivery, rewards recompute, wallet-activity refresh) run in the
// separate `worker` service (see src/worker.ts) — not here. Splitting them
// out means a memory spike in continuous, platform-scale background work
// can no longer take down live user-facing HTTP traffic, and vice versa.
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
