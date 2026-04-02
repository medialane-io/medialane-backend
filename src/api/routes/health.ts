import { Hono } from "hono";
import prisma from "../../db/client.js";
import { createProvider } from "../../utils/starknet.js";
import { toErrorMessage } from "../../utils/error.js";

const health = new Hono();

// Cache the chain tip so Railway health checks (every ~30s) don't each burn an RPC call.
let _cachedLatestBlock: number | undefined;
let _latestBlockFetchedAt = 0;
const LATEST_BLOCK_CACHE_MS = 60_000; // refresh at most once per minute
const LATEST_BLOCK_TTL_MS = 15_000;
let latestBlockCache: { value: number; expiresAt: number } | null = null;

async function getLatestBlockCached(): Promise<number> {
  const now = Date.now();
  if (latestBlockCache && latestBlockCache.expiresAt > now) {
    return latestBlockCache.value;
  }
  const provider = createProvider();
  const value = await provider.getBlockNumber();
  latestBlockCache = { value, expiresAt: now + LATEST_BLOCK_TTL_MS };
  return value;
}

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
      // Refresh the cached chain tip at most once per minute to avoid an RPC call
      // on every Railway health check.
      const now = Date.now();
      if (now - _latestBlockFetchedAt > LATEST_BLOCK_CACHE_MS) {
        try {
          const provider = createProvider();
          const block = await Promise.race([
            provider.getBlockWithTxHashes("latest"),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
          ]);
          _cachedLatestBlock = (block as any).block_number as number;
          _latestBlockFetchedAt = now;
        } catch {
          // non-fatal — keep stale cached value if any
        }
      // Try to get chain tip — if Alchemy is rate-limited just omit it
      let latestBlock: number | undefined;
      try {
        latestBlock = await Promise.race([
          getLatestBlockCached(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
        ]);
      } catch {
        // non-fatal — report lastBlock only
      }
      checks.indexer = {
        lastBlock: cursor.lastBlock.toString(),
        ...(_cachedLatestBlock != null
          ? { latestBlock: _cachedLatestBlock, lagBlocks: _cachedLatestBlock - Number(cursor.lastBlock) }
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
