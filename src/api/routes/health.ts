import { Hono } from "hono";
import prisma from "../../db/client.js";
import { createProvider } from "../../utils/starknet.js";
import { toErrorMessage } from "../../utils/error.js";

const health = new Hono();

// Cache chain tip for indexer lag — refresh at most once per minute (Railway health checks).
let _cachedLatestBlock: number | undefined;
let _latestBlockFetchedAt = 0;
const LATEST_BLOCK_CACHE_MS = 60_000;

async function fetchLatestBlockWithTimeout(): Promise<number> {
  const provider = createProvider();
  return Promise.race([
    provider.getBlockNumber(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
  ]);
}

health.get("/", async (c) => {
  const checks: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (err: unknown) {
    checks.database = `error: ${toErrorMessage(err)}`;
    checks.status = "degraded";
  }

  try {
    const cursor = await prisma.indexerCursor.findUnique({
      where: { chain: "STARKNET" },
    });
    if (cursor) {
      const now = Date.now();
      if (now - _latestBlockFetchedAt > LATEST_BLOCK_CACHE_MS) {
        try {
          _cachedLatestBlock = await fetchLatestBlockWithTimeout();
          _latestBlockFetchedAt = now;
        } catch {
          // non-fatal — keep stale _cachedLatestBlock if any
        }
      }
      checks.indexer = {
        lastBlock: cursor.lastBlock.toString(),
        ...(_cachedLatestBlock != null
          ? {
              latestBlock: _cachedLatestBlock,
              lagBlocks: _cachedLatestBlock - Number(cursor.lastBlock),
            }
          : {}),
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
