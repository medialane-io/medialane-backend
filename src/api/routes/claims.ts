import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import { identityAuth } from "../middleware/identityAuth.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { hashApiKey } from "../../utils/apiKey.js";
import { Account } from "starknet";
import { getCollectionOwner } from "../../chainRead/index.js";
import type { AppEnv } from "../../types/hono.js";
import crypto from "crypto";
import { worker } from "../../orchestrator/worker.js";

// Use AppEnv generic so c.set/c.get are typed correctly for all AppVariables keys
const claims = new Hono<AppEnv>();

import { createSlidingWindow } from "../../utils/slidingWindow.js";

// 10 requests per 60s per tenant ID
const checkRateLimit = createSlidingWindow(10, 60_000);

// Helper: reads API key from x-api-key header ONLY (not Authorization).
// Used on Path 1 where Authorization carries the Clerk JWT.
// Uses hashApiKey to match the actual keyHash stored in the DB (same as apiKeyAuth.ts).
async function xApiKeyAuth(c: any, next: any) {
  const raw = c.req.header("x-api-key");
  if (!raw) return c.json({ error: "Missing API key" }, 401);
  const KEY_SELECT = {
    id: true,
    status: true,
    monthlyRequestCount: true,
    monthlyResetAt: true,
    tenant: { select: { id: true, name: true, email: true, plan: true, status: true } },
    account: { select: { id: true, plan: true, status: true, creditBalance: true } },
  };
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) }, select: KEY_SELECT });
  if (!apiKey || apiKey.status !== "ACTIVE" || !apiKey.account || apiKey.account.status !== "ACTIVE") {
    return c.json({ error: "Invalid or revoked API key" }, 401);
  }
  if (apiKey.tenant && apiKey.tenant.status !== "ACTIVE") {
    return c.json({ error: "Invalid or revoked API key" }, 401);
  }
  c.set("apiKey", apiKey);
  c.set("account", apiKey.account);
  if (apiKey.tenant) c.set("tenant", apiKey.tenant);
  // Fire-and-forget lastUsedAt update — match apiKeyAuth.ts convention
  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  await next();
}

// ─── PATH 1: On-chain auto claim ────────────────────────────────────────────
// Auth: x-api-key (tenant) + Authorization: Bearer (Clerk JWT)

claims.post(
  "/",
  xApiKeyAuth,
  identityAuth,
  zValidator("json", z.object({
    contractAddress: z.string(),
    walletAddress: z.string(),
  })),
  async (c) => {
    const { contractAddress, walletAddress } = c.req.valid("json");
    const jwtWallet = c.get("walletAddress") as string;
    const normContract = normalizeAddress("STARKNET", contractAddress);
    const normWallet = normalizeAddress("STARKNET", walletAddress);

    if (jwtWallet !== normWallet) {
      return c.json({ error: "Wallet address does not match authenticated session" }, 403);
    }

    // Rate limit: 10 claim attempts per minute per tenant
    const tenantId = c.get("tenant")?.id ?? "unknown";
    if (!checkRateLimit(`claim:${tenantId}`)) {
      return c.json({ error: "Rate limit exceeded. Try again in a minute." }, 429);
    }

    // Idempotency: return existing approved claim
    const existing = await prisma.collectionClaim.findFirst({
      where: { contractAddress: normContract, claimantAddress: normWallet, status: { in: ["AUTO_APPROVED", "APPROVED"] } },
    });
    if (existing) {
      const collection = await prisma.collection.findUnique({
        where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normContract } },
      });
      const sc = collection ? { ...collection, startBlock: collection.startBlock.toString() } : null;
      return c.json({ verified: true, collection: sc });
    }

    // On-chain owner() via the single chain-read dispatch (spec §3.3).
    try {
      const onChainOwner = await getCollectionOwner("STARKNET", normContract);
      const ZERO = normalizeAddress("STARKNET", "0x0");
      if (onChainOwner === ZERO || onChainOwner !== normWallet) {
        return c.json({ verified: false, reason: "owner_mismatch" });
      }
    } catch {
      return c.json({ verified: false, reason: "owner_check_failed" });
    }

    // Update-only: a claim records ownership of an already-indexed collection.
    // If the indexer hasn't seen it yet, surface that rather than inventing a row.
    const existingCollection = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normContract } },
    });
    if (!existingCollection) {
      return c.json({ verified: false, reason: "collection_not_indexed" });
    }
    const collection = await prisma.collection.update({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normContract } },
      data: { claimedBy: normWallet },
    });

    await prisma.collectionClaim.create({
      data: { contractAddress: normContract, chain: "STARKNET", claimantAddress: normWallet, status: "AUTO_APPROVED", verificationMethod: "ONCHAIN" },
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: normContract });

    // Serialize BigInt startBlock before JSON response
    const sc = { ...collection, startBlock: collection.startBlock.toString() };
    return c.json({ verified: true, collection: sc });
  }
);

// ─── PATH 2: Challenge ───────────────────────────────────────────────────────
// Auth: standard x-api-key (no Clerk JWT needed).

claims.post(
  "/challenge",
  apiKeyAuth,
  zValidator("json", z.object({ contractAddress: z.string(), walletAddress: z.string() })),
  async (c) => {
    const { contractAddress, walletAddress } = c.req.valid("json");
    const normContract = normalizeAddress("STARKNET", contractAddress);
    const normWallet = normalizeAddress("STARKNET", walletAddress);

    // Enforce 20-challenge cap per wallet (evict oldest)
    const count = await prisma.claimChallenge.count({ where: { walletAddress: normWallet } });
    if (count >= 20) {
      const oldest = await prisma.claimChallenge.findFirst({ where: { walletAddress: normWallet }, orderBy: { createdAt: "asc" } });
      if (oldest) await prisma.claimChallenge.delete({ where: { id: oldest.id } });
    }

    // Delete existing challenge for this pair + clean up expired ones
    await prisma.claimChallenge.deleteMany({ where: { contractAddress: normContract, walletAddress: normWallet } });
    await prisma.claimChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const challenge = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.claimChallenge.create({ data: { contractAddress: normContract, walletAddress: normWallet, challenge, expiresAt } });

    return c.json({ challenge, expiresAt: expiresAt.toISOString() });
  }
);

// ─── PATH 2: Verify signature ────────────────────────────────────────────────

claims.post(
  "/verify",
  apiKeyAuth,
  zValidator("json", z.object({
    contractAddress: z.string(),
    walletAddress: z.string(),
    challenge: z.string(),
    signature: z.object({ r: z.string(), s: z.string() }),
  })),
  async (c) => {
    const { contractAddress, walletAddress, challenge, signature } = c.req.valid("json");
    const normContract = normalizeAddress("STARKNET", contractAddress);
    const normWallet = normalizeAddress("STARKNET", walletAddress);

    const record = await prisma.claimChallenge.findUnique({ where: { challenge } });
    if (!record || record.expiresAt < new Date()) {
      await prisma.claimChallenge.deleteMany({ where: { challenge } });
      return c.json({ verified: false, reason: "challenge_expired_or_not_found" }, 400);
    }
    if (record.walletAddress !== normWallet || record.contractAddress !== normContract) {
      return c.json({ verified: false, reason: "challenge_mismatch" }, 400);
    }

    // Verify SNIP-12 signature using starknet.js v6
    try {
      const typedDataObj = {
        domain: { name: "Medialane", version: "1", chainId: "SN_MAIN", revision: "1" },
        primaryType: "CollectionClaim",
        types: {
          StarknetDomain: [
            { name: "name", type: "shortstring" },
            { name: "version", type: "shortstring" },
            { name: "chainId", type: "shortstring" },
            { name: "revision", type: "shortstring" },
          ],
          CollectionClaim: [
            { name: "contractAddress", type: "ContractAddress" },
            { name: "challenge", type: "shortstring" },
          ],
        },
        message: { contractAddress: normContract, challenge: record.challenge },
      };

      const isValid = await callRpc((provider) => {
        const account = new Account(provider, normWallet, "0x1");
        return account.verifyMessage(typedDataObj, [BigInt(signature.r).toString(), BigInt(signature.s).toString()]);
      });
      if (!isValid) return c.json({ verified: false, reason: "invalid_signature" });
    } catch {
      return c.json({ verified: false, reason: "signature_verification_failed" });
    }

    await prisma.claimChallenge.delete({ where: { challenge } });

    const existingCollection = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normContract } },
    });
    if (!existingCollection) {
      return c.json({ verified: false, reason: "collection_not_indexed" });
    }
    const collection = await prisma.collection.update({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normContract } },
      data: { claimedBy: normWallet },
    });

    await prisma.collectionClaim.create({
      data: { contractAddress: normContract, chain: "STARKNET", claimantAddress: normWallet, status: "AUTO_APPROVED", verificationMethod: "SIGNATURE" },
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: normContract });

    const sc = { ...collection, startBlock: collection.startBlock.toString() };
    return c.json({ verified: true, collection: sc });
  }
);

// ─── PATH 3: Manual off-chain request ────────────────────────────────────────

claims.post(
  "/request",
  apiKeyAuth,
  zValidator("json", z.object({
    contractAddress: z.string(),
    walletAddress: z.string().optional(),
    email: z.string().email(),
    notes: z.string().optional(),
  })),
  async (c) => {
    const { contractAddress, walletAddress, email, notes } = c.req.valid("json");
    const normContract = normalizeAddress("STARKNET", contractAddress);
    const normWallet = walletAddress ? normalizeAddress("STARKNET", walletAddress) : null;

    // Rate limit: 10 requests per minute per tenant
    const tenantId = c.get("tenant")?.id ?? "unknown";
    if (!checkRateLimit(`request:${tenantId}`)) {
      return c.json({ error: "Rate limit exceeded. Try again in a minute." }, 429);
    }

    // Dedup by email+contract — prevents spamming an email address with repeated requests
    const emailDup = await prisma.collectionClaim.findFirst({
      where: { contractAddress: normContract, claimantEmail: email, status: "PENDING" },
    });
    if (emailDup) return c.json({ claim: emailDup });

    // Dedup for wallet-identified requests
    if (normWallet) {
      const existing = await prisma.collectionClaim.findFirst({
        where: { contractAddress: normContract, claimantAddress: normWallet, status: "PENDING" },
      });
      if (existing) return c.json({ claim: existing });
    }

    const claim = await prisma.collectionClaim.create({
      data: { contractAddress: normContract, chain: "STARKNET", claimantAddress: normWallet, claimantEmail: email, status: "PENDING", verificationMethod: "MANUAL", notes },
    });

    return c.json({ claim }, 201);
  }
);

export default claims;
