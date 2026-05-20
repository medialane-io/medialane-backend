import { Hono } from "hono";
import prisma from "../../db/client.js";
import { identityAuth } from "../middleware/identityAuth.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { ensureAccountForWallet } from "../../utils/account.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { AppEnv } from "../../types/hono.js";
import type { WalletType, AppSource, Chain, IdentityProvider } from "@prisma/client";

const users = new Hono<AppEnv>();

const VALID_WALLET_TYPES = new Set<WalletType>([
  "ARGENT", "BRAAVOS", "CARTRIDGE", "PRIVY", "CHIPIPAY", "INJECTED", "UNKNOWN",
]);
const VALID_APP_SOURCES = new Set<AppSource>([
  "MEDIALANE_DAPP", "MEDIALANE_IO", "MEDIALANE_PORTAL", "MEDIALANE_SDK",
]);
const VALID_CHAINS = new Set<Chain>(["STARKNET", "ETHEREUM", "SOLANA", "BITCOIN"]);

function pickProvider(walletType: WalletType, appSource: AppSource): IdentityProvider {
  if (walletType === "PRIVY") return "PRIVY";
  if (walletType === "CHIPIPAY") return "CHIPIPAY";
  if (appSource === "MEDIALANE_IO") return "CLERK";
  return "WALLET";
}

/**
 * POST /v1/users/register
 * Frictionless registration — authenticated by tenant API key.
 * Address provided in body. Idempotent: returns existing Account if already known.
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

  const { accountId } = await ensureAccountForWallet({
    chain,
    address: body.walletAddress,
    walletType,
    appSource,
    identityProvider: pickProvider(walletType, appSource),
  });

  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    include: {
      wallets: {
        where: { chain, address: normalizeAddress(body.walletAddress) },
        take: 1,
      },
    },
  });
  const wallet = account.wallets[0]!;
  return c.json({
    accountId: account.id,
    publicId: account.publicId,
    walletAddress: wallet.address,
    chain: wallet.chain,
    walletType: wallet.walletType,
    appSource,
    createdAt: account.createdAt,
  });
});

/**
 * POST /v1/users/me
 * Upsert the JWT-authenticated caller's account.
 * Works with both Clerk JWT (medialane-io) and SIWS token (medialane-dapp).
 */
users.post("/me", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;
  const body: { walletType?: string; appSource?: string } =
    await c.req
      .json<{ walletType?: string; appSource?: string }>()
      .catch(() => ({}));

  const walletType: WalletType =
    body.walletType && VALID_WALLET_TYPES.has(body.walletType as WalletType)
      ? (body.walletType as WalletType)
      : "UNKNOWN";
  const appSource: AppSource =
    body.appSource && VALID_APP_SOURCES.has(body.appSource as AppSource)
      ? (body.appSource as AppSource)
      : "MEDIALANE_IO";

  await ensureAccountForWallet({
    chain: "STARKNET",
    address: walletAddress,
    walletType,
    appSource,
    identityProvider: pickProvider(walletType, appSource),
  });

  return c.json({ walletAddress });
});

/**
 * GET /v1/users/me
 * Return the JWT-authenticated caller's account info, or 404.
 */
users.get("/me", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;
  const wallet = await prisma.wallet.findUnique({
    where: { chain_address: { chain: "STARKNET", address: walletAddress } },
    include: { account: true },
  });
  if (!wallet) return c.json({ error: "User not found" }, 404);
  return c.json({
    walletAddress: wallet.address,
    accountId: wallet.account.id,
    publicId: wallet.account.publicId,
  });
});

/**
 * GET /v1/users/count
 * Returns account count with optional filters.
 * Auth: tenant API key. Used for Starknet Foundation grant reporting.
 *
 * Filters delegate to Wallet (chain, walletType) and Identity (appSource) — an Account
 * with any matching Wallet/Identity is counted once, regardless of how many it has.
 */
users.get("/count", async (c, next) => apiKeyAuth(c, next), async (c) => {
  const { chain, appSource, walletType, since } = c.req.query();

  const walletWhere: Record<string, unknown> = {};
  const identityWhere: Record<string, unknown> = {};
  if (chain && VALID_CHAINS.has(chain as Chain)) walletWhere.chain = chain;
  if (walletType && VALID_WALLET_TYPES.has(walletType as WalletType))
    walletWhere.walletType = walletType;
  if (appSource && VALID_APP_SOURCES.has(appSource as AppSource))
    identityWhere.appSource = appSource;

  const accountWhere: Record<string, unknown> = {};
  if (Object.keys(walletWhere).length > 0) accountWhere.wallets = { some: walletWhere };
  if (Object.keys(identityWhere).length > 0) accountWhere.identities = { some: identityWhere };
  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) accountWhere.createdAt = { gte: sinceDate };
  }

  const count = await prisma.account.count({ where: accountWhere });
  return c.json({ count, filters: { chain, appSource, walletType, since } });
});

export default users;
