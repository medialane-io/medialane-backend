import { Hono } from "hono";
import prisma from "../../db/client.js";

const health = new Hono();

export const INDEXER_STALL_MS = 10 * 60 * 1000;

export function indexerState(
  updatedAt: Date | null | undefined,
  now: number = Date.now(),
): { indexer: "ok" | "stalled" | "missing"; staleForMs?: number } {
  if (!updatedAt) return { indexer: "missing" };
  const staleForMs = now - updatedAt.getTime();
  return staleForMs > INDEXER_STALL_MS ? { indexer: "stalled", staleForMs } : { indexer: "ok", staleForMs };
}

health.get("/", async (c) => {
  const checks: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "error";
    checks.status = "degraded";
  }

  try {
    const cursor = await prisma.indexerCursor.findUnique({ where: { chain: "STARKNET" } });
    Object.assign(checks, indexerState(cursor?.updatedAt));
    if (cursor) checks.lastBlock = cursor.lastBlock.toString();
  } catch {
    checks.indexer = "error";
  }

  return c.json(checks, checks.status === "ok" ? 200 : 503);
});

export default health;
