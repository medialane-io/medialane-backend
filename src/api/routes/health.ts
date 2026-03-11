import { Hono } from "hono";
import prisma from "../../db/client.js";
import { createProvider } from "../../utils/starknet.js";
import { toErrorMessage } from "../../utils/error.js";

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
  } catch (err: unknown) {
    checks.database = `error: ${toErrorMessage(err)}`;
    checks.status = "degraded";
  }

  // Indexer cursor
  try {
    const cursor = await prisma.indexerCursor.findUnique({
      where: { chain: "STARKNET" },
    });
    if (cursor) {
      // Try to get chain tip — if Alchemy is rate-limited just omit it
      let latestBlock: number | undefined;
      try {
        const provider = createProvider();
        const block = await Promise.race([
          provider.getBlockWithTxHashes("latest"),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
        ]);
        latestBlock = (block as any).block_number as number;
      } catch {
        // non-fatal — report lastBlock only
      }
      checks.indexer = {
        lastBlock: cursor.lastBlock.toString(),
        ...(latestBlock != null ? { latestBlock, lagBlocks: latestBlock - Number(cursor.lastBlock) } : {}),
      };
    } else {
      checks.indexer = "not started";
    }
  } catch (err: unknown) {
    checks.indexer = `error: ${toErrorMessage(err)}`;
  }

  const status = checks.status === "ok" ? 200 : 503;
  return c.json(checks, status);
});

export default health;
