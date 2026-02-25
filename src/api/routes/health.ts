import { Hono } from "hono";
import prisma from "../../db/client.js";
import { createProvider } from "../../utils/starknet.js";

const health = new Hono();

health.get("/", async (c) => {
  const checks: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };

  // DB check
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (err: any) {
    checks.database = `error: ${err.message}`;
    checks.status = "degraded";
  }

  // Indexer cursor
  try {
    const cursor = await prisma.indexerCursor.findUnique({
      where: { id: "singleton" },
    });
    if (cursor) {
      const provider = createProvider();
      const block = await provider.getBlockWithTxHashes("latest");
      const latestBlock = (block as any).block_number as number;
      const lag = latestBlock - Number(cursor.lastBlock);
      checks.indexer = {
        lastBlock: cursor.lastBlock.toString(),
        latestBlock,
        lagBlocks: lag,
      };
    } else {
      checks.indexer = "not started";
    }
  } catch (err: any) {
    checks.indexer = `error: ${err.message}`;
  }

  const status = checks.status === "ok" ? 200 : 503;
  return c.json(checks, status);
});

export default health;
