import { Hono } from "hono";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:pop");

const pop = new Hono<AppEnv>();

// GET /v1/pop/eligibility/:collection/:wallet
// Returns whether a wallet is eligible to claim from a POP collection and whether they already have.
// isEligible: wallet is in the allowlist with allowed=true
// hasClaimed:  wallet currently owns a token from this collection (soulbound — owner = original recipient)
pop.get("/eligibility/:collection/:wallet", async (c) => {
  const collection = normalizeAddress(c.req.param("collection"));
  const wallet = normalizeAddress(c.req.param("wallet"));

  const [allowlistEntry, token] = await Promise.all([
    prisma.popAllowlist.findUnique({
      where: {
        chain_collectionAddress_walletAddress: {
          chain: "STARKNET",
          collectionAddress: collection,
          walletAddress: wallet,
        },
      },
      select: { allowed: true },
    }),
    prisma.token.findFirst({
      where: { chain: "STARKNET", contractAddress: collection, owner: wallet },
      select: { tokenId: true },
    }),
  ]);

  return c.json({
    data: {
      isEligible: allowlistEntry?.allowed ?? false,
      hasClaimed: token !== null,
      tokenId: token?.tokenId ?? null,
    },
  });
});

// GET /v1/pop/eligibility/:collection — batch eligibility check
// Query param: ?wallets=0x1,0x2,0x3 (comma-separated, max 100)
pop.get("/eligibility/:collection", async (c) => {
  const collection = normalizeAddress(c.req.param("collection"));
  const walletsParam = c.req.query("wallets");

  if (!walletsParam) {
    return c.json({ error: "wallets query param is required" }, 400);
  }

  const wallets = walletsParam
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map(normalizeAddress);

  if (wallets.length === 0) {
    return c.json({ error: "No valid wallet addresses provided" }, 400);
  }

  const [allowlistEntries, tokens] = await Promise.all([
    prisma.popAllowlist.findMany({
      where: {
        chain: "STARKNET",
        collectionAddress: collection,
        walletAddress: { in: wallets },
      },
      select: { walletAddress: true, allowed: true },
    }),
    prisma.token.findMany({
      where: { chain: "STARKNET", contractAddress: collection, owner: { in: wallets } },
      select: { owner: true, tokenId: true },
    }),
  ]);

  const allowlistMap = new Map(allowlistEntries.map((e) => [e.walletAddress, e.allowed]));
  const tokenMap = new Map(tokens.map((t) => [t.owner, t.tokenId]));

  const data = wallets.map((wallet) => ({
    wallet,
    isEligible: allowlistMap.get(wallet) ?? false,
    hasClaimed: tokenMap.has(wallet),
    tokenId: tokenMap.get(wallet) ?? null,
  }));

  return c.json({ data });
});

export default pop;
