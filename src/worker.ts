import { startMirror } from "./mirror/index.js";
import { registerIngestors, type ChainIngestor } from "./mirror/ingestor.js";
import { startOrchestrator } from "./orchestrator/index.js";
import { worker } from "./orchestrator/worker.js";
import { createLogger } from "./utils/logger.js";
import prisma from "./db/client.js";

const log = createLogger("main:worker");

async function main() {
  log.info({ chain: "STARKNET" }, "Starting Medialane Worker");

  try {
    await prisma.$connect();
    log.info("Database connected");
  } catch (err) {
    log.fatal({ err }, "Database connection failed");
    process.exit(1);
  }

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
  log.info("Shutting down Medialane Worker...");
  await worker.waitDrain(10_000);
  await prisma.$disconnect();
  process.exit(0);
}

main();
