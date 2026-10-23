import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import { identityAuth } from "../middleware/identityAuth.js";
import { getCollectionOwner } from "../../chainRead/index.js";
import type { AppEnv } from "../../types/hono.js";
import crypto from "crypto";
import type { Chain } from "@prisma/client";
import { worker } from "../../orchestrator/worker.js";
import { detectTokenStandard } from "../../orchestrator/collectionMetadata.js";
import { catchUpCollectionTransfers } from "../../mirror/sources.js";
import { ensureCollectionFromActivity } from "../../utils/collection.js";
import { createLogger } from "../../utils/logger.js";
import { chainScope } from "../http/chain.js";

const log = createLogger("routes:claims");

const claims = new Hono<AppEnv>();

async function indexCollection(chain: Chain, contractAddress: string): Promise<boolean> {
  const existing = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
    select: { contractAddress: true },
  });
  if (existing) return true;

  const standard = await detectTokenStandard(contractAddress);
  if (!standard) return false;

  await ensureCollectionFromActivity(prisma, { chain, contractAddress, standard, blockNumber: 0n });
  void catchUpCollectionTransfers([contractAddress])
    .then(async () => {
      const pendingTokens = await prisma.token.findMany({
        where: { chain, contractAddress, metadataStatus: "PENDING" },
        select: { tokenId: true },
      });
      for (const token of pendingTokens) {
        worker.enqueue({ type: "METADATA_FETCH", chain, contractAddress, tokenId: token.tokenId });
      }
    })
    .catch((err) => log.error({ err, contractAddress }, "Claimed collection transfers could not be read"));
  return true;
}



claims.post(
  "/",
  identityAuth,
  zValidator("json", z.object({
    contractAddress: z.string(),
    walletAddress: z.string(),
  })),
  chainScope(),
  async (c) => {
  const chain = c.get("chain");

    const { contractAddress, walletAddress } = c.req.valid("json");
    const jwtWallet = c.get("walletAddress") as string;
    const normContract = normalizeAddress(chain, contractAddress);
    const normWallet = normalizeAddress(chain, walletAddress);

    if (jwtWallet !== normWallet) {
      return c.json({ error: "Wallet address does not match authenticated session" }, 403);
    }

    const existing = await prisma.collectionClaim.findFirst({
      where: { contractAddress: normContract, claimantAddress: normWallet, status: { in: ["AUTO_APPROVED", "APPROVED"] } },
    });
    if (existing) {
      const collection = await prisma.collection.findUnique({
        where: { chain_contractAddress: { chain, contractAddress: normContract } },
      });
      const sc = collection ? { ...collection, startBlock: collection.startBlock.toString() } : null;
      return c.json({ verified: true, collection: sc });
    }

    try {
      const onChainOwner = await getCollectionOwner(chain, normContract);
      const ZERO = normalizeAddress(chain, "0x0");
      if (onChainOwner === ZERO || onChainOwner !== normWallet) {
        return c.json({ verified: false, reason: "owner_mismatch" });
      }
    } catch {
      return c.json({ verified: false, reason: "owner_check_failed" });
    }

    if (!(await indexCollection(chain, normContract))) {
      return c.json({ verified: false, reason: "not_an_nft_collection" });
    }
    const collection = await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress: normContract } },
      data: { claimedBy: normWallet },
    });

    await prisma.collectionClaim.create({
      data: { contractAddress: normContract, chain, claimantAddress: normWallet, status: "AUTO_APPROVED", verificationMethod: "ONCHAIN" },
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain, contractAddress: normContract });

    const sc = { ...collection, startBlock: collection.startBlock.toString() };
    return c.json({ verified: true, collection: sc });
  }
);

claims.post(
  "/challenge",
  zValidator("json", z.object({ contractAddress: z.string(), walletAddress: z.string() })),
  chainScope(),
  async (c) => {
  const chain = c.get("chain");

    const { contractAddress, walletAddress } = c.req.valid("json");
    const normContract = normalizeAddress(chain, contractAddress);
    const normWallet = normalizeAddress(chain, walletAddress);

    const count = await prisma.claimChallenge.count({ where: { walletAddress: normWallet } });
    if (count >= 20) {
      const oldest = await prisma.claimChallenge.findFirst({ where: { walletAddress: normWallet }, orderBy: { createdAt: "asc" } });
      if (oldest) await prisma.claimChallenge.delete({ where: { id: oldest.id } });
    }

    await prisma.claimChallenge.deleteMany({ where: { contractAddress: normContract, walletAddress: normWallet } });
    await prisma.claimChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const challenge = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.claimChallenge.create({ data: { contractAddress: normContract, walletAddress: normWallet, challenge, expiresAt } });

    return c.json({ challenge, expiresAt: expiresAt.toISOString() });
  }
);

claims.post(
  "/verify",
  zValidator("json", z.object({
    contractAddress: z.string(),
    walletAddress: z.string(),
    challenge: z.string(),
    signature: z.object({ r: z.string(), s: z.string() }),
  })),
  chainScope(),
  async (c) => {
  const chain = c.get("chain");

    const { contractAddress, walletAddress, challenge, signature } = c.req.valid("json");
    const normContract = normalizeAddress(chain, contractAddress);
    const normWallet = normalizeAddress(chain, walletAddress);

    const record = await prisma.claimChallenge.findUnique({ where: { challenge } });
    if (!record || record.expiresAt < new Date()) {
      await prisma.claimChallenge.deleteMany({ where: { challenge } });
      return c.json({ verified: false, reason: "challenge_expired_or_not_found" }, 400);
    }
    if (record.walletAddress !== normWallet || record.contractAddress !== normContract) {
      return c.json({ verified: false, reason: "challenge_mismatch" }, 400);
    }

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

        return provider.verifyMessageInStarknet(
          typedDataObj,
          [BigInt(signature.r).toString(), BigInt(signature.s).toString()],
          normWallet,
        );
      });
      if (!isValid) return c.json({ verified: false, reason: "invalid_signature" });
    } catch {
      return c.json({ verified: false, reason: "signature_verification_failed" });
    }

    try {
      const onChainOwner = await getCollectionOwner(chain, normContract);
      if (onChainOwner === normalizeAddress(chain, "0x0") || onChainOwner !== normWallet) {
        return c.json({ verified: false, reason: "owner_mismatch" });
      }
    } catch {
      return c.json({ verified: false, reason: "owner_check_failed" });
    }

    await prisma.claimChallenge.delete({ where: { challenge } });

    if (!(await indexCollection(chain, normContract))) {
      return c.json({ verified: false, reason: "not_an_nft_collection" });
    }
    const collection = await prisma.collection.update({
      where: { chain_contractAddress: { chain, contractAddress: normContract } },
      data: { claimedBy: normWallet },
    });

    await prisma.collectionClaim.create({
      data: { contractAddress: normContract, chain, claimantAddress: normWallet, status: "AUTO_APPROVED", verificationMethod: "SIGNATURE" },
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain, contractAddress: normContract });

    const sc = { ...collection, startBlock: collection.startBlock.toString() };
    return c.json({ verified: true, collection: sc });
  }
);

claims.post(
  "/request",
  zValidator("json", z.object({
    contractAddress: z.string(),
    walletAddress: z.string().optional(),
    email: z.string().email(),
    notes: z.string().optional(),
  })),
  chainScope(),
  async (c) => {
  const chain = c.get("chain");

    const { contractAddress, walletAddress, email, notes } = c.req.valid("json");
    const normContract = normalizeAddress(chain, contractAddress);
    const normWallet = walletAddress ? normalizeAddress(chain, walletAddress) : null;

    const emailDup = await prisma.collectionClaim.findFirst({
      where: { contractAddress: normContract, claimantEmail: email, status: "PENDING" },
    });
    if (emailDup) return c.json({ claim: emailDup });

    if (normWallet) {
      const existing = await prisma.collectionClaim.findFirst({
        where: { contractAddress: normContract, claimantAddress: normWallet, status: "PENDING" },
      });
      if (existing) return c.json({ claim: existing });
    }

    const claim = await prisma.collectionClaim.create({
      data: { contractAddress: normContract, chain, claimantAddress: normWallet, claimantEmail: email, status: "PENDING", verificationMethod: "MANUAL", notes },
    });

    return c.json({ claim }, 201);
  }
);

export default claims;
