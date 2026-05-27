import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { identityAuth } from "../middleware/identityAuth.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { ensureAccountForWallet } from "../../utils/account.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { AppEnv } from "../../types/hono.js";
import type { WalletType, AppSource, Chain, IdentityProvider } from "@prisma/client";

const users = new Hono<AppEnv>();

const walletTypeEnum = z.enum([
  "ARGENT", "BRAAVOS", "CARTRIDGE", "PRIVY", "CHIPIPAY", "INJECTED", "UNKNOWN",
]);
const appSourceEnum = z.enum([
  "MEDIALANE_DAPP", "MEDIALANE_IO", "MEDIALANE_PORTAL", "MEDIALANE_SDK",
]);
const chainEnum = z.enum(["STARKNET", "ETHEREUM", "SOLANA", "BITCOIN"]);

const VALID_CHAINS = new Set<Chain>(["STARKNET", "ETHEREUM", "SOLANA", "BITCOIN"]);
const VALID_WALLET_TYPES = new Set<WalletType>([
  "ARGENT", "BRAAVOS", "CARTRIDGE", "PRIVY", "CHIPIPAY", "INJECTED", "UNKNOWN",
]);
const VALID_APP_SOURCES = new Set<AppSource>([
  "MEDIALANE_DAPP", "MEDIALANE_IO", "MEDIALANE_PORTAL", "MEDIALANE_SDK",
]);

const registerBodySchema = z.object({
  walletAddress: z.string().min(1, "walletAddress is required"),
  walletType: walletTypeEnum.optional(),
  appSource: appSourceEnum.optional(),
  chain: chainEnum.optional(),
});

const meBodySchema = z.object({
  walletType: walletTypeEnum.optional(),
  appSource: appSourceEnum.optional(),
  // 07-identity §I: the Wallet identifier is (chain, address). Accepting
  // `chain` from the client lets callers explicitly assert the chain
  // they're registering — currently always STARKNET, but locking the
  // shape in v1 is what keeps the year-2 multichain path unblocked.
  // Optional and defaults to STARKNET so older clients keep working.
  chain: chainEnum.optional(),
});

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
users.post("/register", async (c, next) => apiKeyAuth(c, next), zValidator("json", registerBodySchema), async (c) => {
  const body = c.req.valid("json");
  const walletType: WalletType = body.walletType ?? "UNKNOWN";
  const appSource: AppSource = body.appSource ?? "MEDIALANE_DAPP";
  const chain: Chain = body.chain ?? "STARKNET";

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
  const raw = await c.req.json<unknown>().catch(() => ({}));
  const parsed = meBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  const walletType: WalletType = parsed.data.walletType ?? "UNKNOWN";
  const appSource: AppSource = parsed.data.appSource ?? "MEDIALANE_IO";
  const chain: Chain = parsed.data.chain ?? "STARKNET";

  // identityAuth only issues tokens for Starknet wallets in v1 (Clerk JWT
  // carries a ChipiPay Starknet address; SIWS proves a Starknet signature).
  // Accepting a non-STARKNET chain from the body would mis-register a
  // Starknet-derived address under another chain. When SIWE / SIWB land
  // and identityAuth issues tokens for other chains, this guard relaxes.
  if (chain !== "STARKNET") {
    return c.json({
      error: "Only STARKNET is supported on /v1/users/me in v1 — cross-chain registration arrives with SIWE/SIWB",
    }, 400);
  }

  await ensureAccountForWallet({
    chain,
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
