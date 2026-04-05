import { Hono } from "hono";
import prisma from "../../db/client.js";

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
  } catch {
    checks.database = "error";
    checks.status = "degraded";
  }

  // Indexer cursor — presence check only, no block numbers exposed publicly
  try {
    const cursor = await prisma.indexerCursor.findUnique({
      where: { chain: "STARKNET" },
    });
    checks.indexer = cursor ? "ok" : "degraded";
  } catch {
    checks.indexer = "error";
  }

  const status = checks.status === "ok" ? 200 : 503;
  return c.json(checks, status);
});

export default health;
