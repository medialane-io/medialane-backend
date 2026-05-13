import { Hono } from "hono";
import prisma from "../../db/client.js";
import { identityAuth } from "../middleware/identityAuth.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import type { AppEnv } from "../../types/hono.js";
import type { WalletType, AppSource, Chain } from "@prisma/client";

const users = new Hono<AppEnv>();

const VALID_WALLET_TYPES = new Set<WalletType>([
  "ARGENT", "BRAAVOS", "CARTRIDGE", "PRIVY", "CHIPIPAY", "INJECTED", "UNKNOWN",
]);
const VALID_APP_SOURCES = new Set<AppSource>([
  "MEDIALANE_DAPP", "MEDIALANE_IO", "MEDIALANE_PORTAL", "MEDIALANE_SDK",
]);
const VALID_CHAINS = new Set<Chain>(["STARKNET", "ETHEREUM", "SOLANA", "BITCOIN"]);

/**
 * POST /v1/users/register
 * Frictionless registration — authenticated by tenant API key.
 * Address provided in body. Idempotent upsert.
 * Called by medialane-dapp after wallet connects (no user signature needed).
 */
users.post("/register", async (c, next) => apiKeyAuth(c, next), async (c) => {
  const body = await c.req.json<{
    walletAddress?: string;
    walletType?: string;
    appSource?: string;
    chain?: string;
  }>();

  if (!body.walletAddress || typeof body.walletAddress !== "string") {
    return c.json({ error: "walletAddress is required" }, 400);
  }

  const walletType: WalletType =
    body.walletType && VALID_WALLET_TYPES.has(body.walletType as WalletType)
      ? (body.walletType as WalletType)
      : "UNKNOWN";

  const appSource: AppSource =
    body.appSource && VALID_APP_SOURCES.has(body.appSource as AppSource)
      ? (body.appSource as AppSource)
      : "MEDIALANE_DAPP";

  const chain: Chain =
    body.chain && VALID_CHAINS.has(body.chain as Chain)
      ? (body.chain as Chain)
      : "STARKNET";

  const user = await prisma.user.upsert({
    where: { walletAddress: body.walletAddress },
    create: { walletAddress: body.walletAddress, chain, walletType, appSource },
    update: { walletType, appSource },
  });

  return c.json({
    walletAddress: user.walletAddress,
    chain: user.chain,
    walletType: user.walletType,
    appSource: user.appSource,
    createdAt: user.createdAt,
  });
});

/**
 * POST /v1/users/me
 * Upsert the authenticated user's wallet address.
 * Accepts optional walletType and appSource in body.
 * Works with both Clerk JWT (medialane-io) and SIWS token (medialane-dapp).
 */
users.post("/me", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;

  const body: { walletType?: string; appSource?: string } =
    await c.req.json<{ walletType?: string; appSource?: string }>().catch(() => ({ walletType: undefined, appSource: undefined }));

  const walletType: WalletType =
    body.walletType && VALID_WALLET_TYPES.has(body.walletType as WalletType)
      ? (body.walletType as WalletType)
      : "UNKNOWN";

  const appSource: AppSource =
    body.appSource && VALID_APP_SOURCES.has(body.appSource as AppSource)
      ? (body.appSource as AppSource)
      : "MEDIALANE_IO";

  await prisma.user.upsert({
    where: { walletAddress },
    create: { walletAddress, walletType, appSource },
    update: { walletType, appSource },
  });

  return c.json({ walletAddress });
});

/**
 * GET /v1/users/me
 * Return the authenticated user's stored record.
 * Returns 404 if not registered yet.
 */
users.get("/me", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;
  const user = await prisma.user.findUnique({ where: { walletAddress } });
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json({ walletAddress: user.walletAddress });
});

/**
 * GET /v1/users/count
 * Returns registered user count with optional filters.
 * Auth: tenant API key. Used for Starknet Foundation grant reporting.
 */
users.get("/count", async (c, next) => apiKeyAuth(c, next), async (c) => {
  const { chain, appSource, walletType, since } = c.req.query();

  const where: Record<string, unknown> = {};
  if (chain && VALID_CHAINS.has(chain as Chain)) where.chain = chain;
  if (appSource && VALID_APP_SOURCES.has(appSource as AppSource)) where.appSource = appSource;
  if (walletType && VALID_WALLET_TYPES.has(walletType as WalletType)) where.walletType = walletType;
  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) where.createdAt = { gte: sinceDate };
  }

  const count = await prisma.user.count({ where });
  return c.json({ count, filters: { chain, appSource, walletType, since } });
});

export default users;
