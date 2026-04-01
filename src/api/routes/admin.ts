import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import prisma from "../../db/client.js";
import { generateApiKey } from "../../utils/apiKey.js";
import { handleMetadataFetch } from "../../orchestrator/metadata.js";
import { handleCollectionMetadataFetch } from "../../orchestrator/collectionMetadata.js";
import { handleStatsUpdate } from "../../orchestrator/stats.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import { sendUsernameClaimApproved, sendUsernameClaimRejected } from "../../utils/mailer.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { handleOrderCreated } from "../../mirror/handlers/orderCreated.js";
import { pollTransferEvents, getLatestBlock } from "../../mirror/poller.js";
import { handleTransfer } from "../../mirror/handlers/transfer.js";
import { parseEvents } from "../../mirror/parser.js";

import { InMemoryRateLimitStore } from "../middleware/rateLimit.js";

const log = createLogger("routes:admin");
const admin = new Hono();

// Simple IP-based rate limiter for admin routes (20 req/min per IP)
const adminRateLimitStore = new InMemoryRateLimitStore();
const ADMIN_RATE_LIMIT = 20;
const ADMIN_WINDOW_MS = 60_000;

// All admin routes require the admin secret + IP-based rate limit
admin.use("*", authMiddleware);
admin.use("*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const { count, resetAt } = await adminRateLimitStore.increment(`admin:${ip}`, ADMIN_WINDOW_MS);
  if (count > ADMIN_RATE_LIMIT) {
    c.header("Retry-After", String(Math.ceil((resetAt - Date.now()) / 1000)));
    return c.json({ error: "Too many requests" }, 429);
  }
  await next();
});

// ---------------------------------------------------------------------------
// POST /admin/tenants — create tenant + initial API key
// ---------------------------------------------------------------------------
const createTenantSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  plan: z.enum(["FREE", "PREMIUM"]).default("FREE"),
  keyLabel: z.string().optional(),
});

admin.post("/tenants", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createTenantSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { name, email, plan, keyLabel } = parsed.data;

  const existing = await prisma.tenant.findUnique({ where: { email } });
  if (existing) {
    return c.json({ error: "Email already registered" }, 409);
  }

  const { plaintext, prefix, keyHash } = generateApiKey();

  const tenant = await prisma.tenant.create({
    data: {
      name,
      email,
      plan,
      apiKeys: {
        create: { prefix, keyHash, label: keyLabel ?? "default" },
      },
    },
    include: { apiKeys: true },
  });

  log.info({ tenantId: tenant.id, email }, "Tenant created");

  return c.json(
    {
      data: {
        tenant: { id: tenant.id, name, email, plan, status: tenant.status },
        apiKey: {
          id: tenant.apiKeys[0].id,
          prefix,
          label: tenant.apiKeys[0].label,
          // Plaintext shown ONCE — not stored
          plaintext,
        },
      },
    },
    201
  );
});

// ---------------------------------------------------------------------------
// GET /admin/tenants — list all tenants
// ---------------------------------------------------------------------------
admin.get("/tenants", async (c) => {
  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { apiKeys: true } } },
  });

  return c.json({
    data: tenants.map((t) => ({
      id: t.id,
      name: t.name,
      email: t.email,
      plan: t.plan,
      status: t.status,
      keyCount: t._count.apiKeys,
      createdAt: t.createdAt,
    })),
  });
});

// ---------------------------------------------------------------------------
// PATCH /admin/tenants/:id — update plan or status
// ---------------------------------------------------------------------------
const updateTenantSchema = z.object({
  plan: z.enum(["FREE", "PREMIUM"]).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});

admin.patch("/tenants/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);
  const parsed = updateTenantSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  if (!parsed.data.plan && !parsed.data.status) {
    return c.json({ error: "Provide plan or status to update" }, 400);
  }

  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const updated = await prisma.tenant.update({
    where: { id },
    data: parsed.data,
  });

  return c.json({ data: { id, plan: updated.plan, status: updated.status } });
});

// ---------------------------------------------------------------------------
// POST /admin/tenants/:id/keys — create additional key
// ---------------------------------------------------------------------------
const createKeySchema = z.object({
  label: z.string().optional(),
});

admin.post("/tenants/:id/keys", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);
  const parsed = createKeySchema.safeParse(body ?? {});

  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const { plaintext, prefix, keyHash } = generateApiKey();
  const label = parsed.success ? (parsed.data.label ?? "") : "";

  const apiKey = await prisma.apiKey.create({
    data: { tenantId: id, prefix, keyHash, label },
  });

  return c.json(
    {
      data: {
        id: apiKey.id,
        prefix,
        label: apiKey.label,
        plaintext, // shown ONCE
      },
    },
    201
  );
});

// ---------------------------------------------------------------------------
// DELETE /admin/keys/:keyId — revoke key (soft delete)
// ---------------------------------------------------------------------------
admin.delete("/keys/:keyId", async (c) => {
  const { keyId } = c.req.param();

  const apiKey = await prisma.apiKey.findUnique({
    where: { id: keyId },
    include: { tenant: true },
  });
  if (!apiKey) return c.json({ error: "Key not found" }, 404);

  await prisma.apiKey.update({
    where: { id: keyId },
    data: { status: "REVOKED" },
  });

  return c.json({ data: { id: keyId, status: "REVOKED" } });
});

// ---------------------------------------------------------------------------
// POST /admin/tokens/:contract/:tokenId/refresh — force sync metadata
// ---------------------------------------------------------------------------
admin.post("/tokens/:contract/:tokenId/refresh", async (c) => {
  const { contract, tokenId } = c.req.param();
  const contractAddress = normalizeAddress(contract);

  // Guard: only refresh tokens from registered collections to prevent
  // arbitrary on-chain RPC calls for unregistered contracts.
  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    select: { id: true },
  });
  if (!col) return c.json({ error: "Collection not registered" }, 404);

  try {
    await handleMetadataFetch({ chain: "STARKNET", contractAddress, tokenId });
    const token = await prisma.token.findUnique({
      where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress, tokenId } },
    });
    return c.json({ data: { metadataStatus: token?.metadataStatus, tokenUri: token?.tokenUri, name: token?.name } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/collections — register a new collection address + enqueue metadata fetch
// ---------------------------------------------------------------------------
admin.post("/collections", async (c) => {
  const body = await c.req.json().catch(() => null);
  const schema = z.object({
    contractAddress: z.string().min(1),
    chain: z.string().optional().default("STARKNET"),
    startBlock: z.number().optional().default(0),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const { contractAddress: rawAddr, chain, startBlock } = parsed.data;
  const contractAddress = normalizeAddress(rawAddr);

  const col = await prisma.collection.upsert({
    where: { chain_contractAddress: { chain: chain as any, contractAddress } },
    create: { chain: chain as any, contractAddress, metadataStatus: "PENDING", startBlock: BigInt(startBlock) },
    update: {},
  });

  worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: chain as any, contractAddress });

  log.info({ contractAddress, chain }, "Collection registered via admin");

  return c.json({ data: { id: col.id, contractAddress, chain, metadataStatus: col.metadataStatus } }, 201);
});

// ---------------------------------------------------------------------------
// PATCH /admin/collections/:contract — update collection fields (name, description, image, isKnown)
// ---------------------------------------------------------------------------
admin.patch("/collections/:contract", async (c) => {
  const { contract } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const schema = z.object({
    name:         z.string().optional(),
    symbol:       z.string().optional(),
    description:  z.string().optional(),
    image:        z.string().optional(),
    isKnown:      z.boolean().optional(),
    isHidden:     z.boolean().optional(),
    owner:        z.string().optional(),
    collectionId: z.string().optional(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normalizeAddress(contract) } },
  });
  if (!col) return c.json({ error: "Collection not found" }, 404);

  const updateData = {
    ...parsed.data,
    ...(parsed.data.owner ? { owner: normalizeAddress(parsed.data.owner) } : {}),
  };
  const updated = await prisma.collection.update({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normalizeAddress(contract) } },
    data: updateData,
  });

  return c.json({ data: { contractAddress: updated.contractAddress, name: updated.name, isKnown: updated.isKnown } });
});

// ---------------------------------------------------------------------------
// DELETE /admin/collections/:contract — soft-delete (sets isHidden + records deletion metadata)
// ---------------------------------------------------------------------------
admin.delete("/collections/:contract", async (c) => {
  const { contract } = c.req.param();
  const contractAddress = normalizeAddress(contract);

  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    select: { id: true, deletedAt: true },
  });
  if (!col) return c.json({ error: "Collection not found" }, 404);
  if (col.deletedAt) return c.json({ error: "Collection already deleted" }, 409);

  const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  await prisma.collection.update({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    data: { isHidden: true, deletedAt: new Date(), deletedBy: ip },
  });

  log.info({ contractAddress, ip }, "Collection soft-deleted via admin");

  return c.json({ data: { contractAddress, deletedAt: new Date().toISOString() } });
});

// ---------------------------------------------------------------------------
// POST /admin/collections/:contract/refresh — force sync collection metadata
// ---------------------------------------------------------------------------
admin.post("/collections/:contract/refresh", async (c) => {
  const { contract } = c.req.param();
  const contractAddress = normalizeAddress(contract);
  try {
    await handleCollectionMetadataFetch({ chain: "STARKNET", contractAddress });
    // Also enqueue stats update to backfill totalSupply, holderCount, and image/description from tokens
    worker.enqueue({ type: "STATS_UPDATE", chain: "STARKNET", contractAddress });
    const col = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    });
    return c.json({ data: { metadataStatus: col?.metadataStatus, name: col?.name, symbol: col?.symbol } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/collections/:contract/stats-refresh — force sync stats + backfill image/description
// ---------------------------------------------------------------------------
admin.post("/collections/:contract/stats-refresh", async (c) => {
  const { contract } = c.req.param();
  const contractAddress = normalizeAddress(contract);
  try {
    await handleStatsUpdate({ chain: "STARKNET", contractAddress });
    const col = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    });
    return c.json({ data: { totalSupply: col?.totalSupply, holderCount: col?.holderCount, image: col?.image, description: col?.description } });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/collections/:contract/backfill-transfers — scan historical Transfer events
// ---------------------------------------------------------------------------
// Fetches all ERC-721 Transfer events for the contract between fromBlock and toBlock,
// upserts Token + Transfer rows, and enqueues METADATA_FETCH for every new token.
// Use this when a collection was registered after its mints already happened.
admin.post("/collections/:contract/backfill-transfers", async (c) => {
  const { contract } = c.req.param();
  const contractAddress = normalizeAddress(contract);

  const body = await c.req.json().catch(() => ({}));
  const schema = z.object({
    fromBlock: z.number().int().min(0).default(0),
    toBlock:   z.number().int().min(0).optional(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const latestBlock = await getLatestBlock();
  const fromBlock   = parsed.data.fromBlock;
  const toBlock     = parsed.data.toBlock ?? latestBlock;

  if (fromBlock > toBlock) {
    return c.json({ error: `fromBlock (${fromBlock}) must be ≤ toBlock (${toBlock})` }, 400);
  }

  log.info({ contractAddress, fromBlock, toBlock }, "Starting Transfer backfill");

  const rawEvents = await pollTransferEvents(contractAddress, fromBlock, toBlock);
  const parsedEvents = parseEvents(rawEvents);
  const transferEvents = parsedEvents.filter((e) => e.type === "Transfer");

  let inserted = 0;
  let skipped  = 0;

  for (const event of transferEvents) {
    if (event.type !== "Transfer") continue;
    try {
      await prisma.$transaction(async (tx) => {
        await handleTransfer(event, tx, "STARKNET");
      });
      inserted++;
    } catch (err: unknown) {
      // P2002 = unique constraint — already processed
      if ((err as { code?: string }).code === "P2002") {
        skipped++;
      } else {
        log.warn({ err, tokenId: event.tokenId }, "Transfer backfill row error — skipping");
        skipped++;
      }
    }
  }

  // Enqueue metadata fetch for all PENDING tokens in this collection
  const pendingTokens = await prisma.token.findMany({
    where: { chain: "STARKNET", contractAddress, metadataStatus: "PENDING" },
    select: { tokenId: true },
  });
  for (const t of pendingTokens) {
    worker.enqueue({ type: "METADATA_FETCH", chain: "STARKNET", contractAddress, tokenId: t.tokenId });
  }

  // Trigger stats update
  worker.enqueue({ type: "STATS_UPDATE", chain: "STARKNET", contractAddress });

  log.info({ contractAddress, inserted, skipped, metadataJobs: pendingTokens.length }, "Transfer backfill complete");

  return c.json({
    data: {
      contractAddress,
      fromBlock,
      toBlock,
      rawEvents: rawEvents.length,
      inserted,
      skipped,
      metadataJobsEnqueued: pendingTokens.length,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /admin/collections/backfill-metadata — enqueue fetch for all PENDING
// ---------------------------------------------------------------------------
admin.post("/collections/backfill-metadata", async (c) => {
  const collections = await prisma.collection.findMany({
    where: {
      OR: [
        { metadataStatus: "PENDING" },
        { metadataStatus: "FAILED" },
        { name: null },
        { owner: null },
      ],
    },
    select: { chain: true, contractAddress: true, metadataStatus: true, name: true },
  });

  for (const col of collections) {
    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: col.chain as any, contractAddress: col.contractAddress });
  }

  return c.json({ data: { enqueued: collections.length } });
});

// ---------------------------------------------------------------------------
// POST /admin/collections/backfill-registry — scan all CollectionCreated events
// on-chain and upsert every collection that's missing from the DB.
// ---------------------------------------------------------------------------
import { resolveCollectionCreated } from "../../mirror/handlers/collectionCreated.js";
import { RpcProvider, num as starkNum } from "starknet";
import { COLLECTION_CONTRACT, COLLECTION_CREATED_SELECTOR } from "../../config/constants.js";
import { env } from "../../config/env.js";

admin.post("/collections/backfill-registry", async (c) => {
  const provider = new RpcProvider({ nodeUrl: env.ALCHEMY_RPC_URL });
  const latestBlock = await provider.getBlockLatestAccepted();

  let continuationToken: string | undefined = undefined;
  let inserted = 0;
  let skipped = 0;

  do {
    const result = await provider.getEvents({
      address: COLLECTION_CONTRACT,
      from_block: { block_number: 6204232 },
      to_block: { block_number: latestBlock.block_number },
      keys: [[starkNum.toHex(COLLECTION_CREATED_SELECTOR)]],
      chunk_size: 100,
      continuation_token: continuationToken,
    });

    for (const event of result.events ?? []) {
      const data = event.data;
      if (!data || data.length < 3) continue;
      const collectionId = (BigInt(data[0]) + (BigInt(data[1]) << 128n)).toString();
      const owner = normalizeAddress(data[2]);
      const blockNumber = BigInt(event.block_number ?? 0);

      const resolved = await resolveCollectionCreated({
        type: "CollectionCreated",
        collectionId,
        owner,
        blockNumber,
        txHash: event.transaction_hash ?? "",
        logIndex: 0,
      });

      if (!resolved) { skipped++; continue; }

      await prisma.collection.upsert({
        where: { chain_contractAddress: { chain: "STARKNET", contractAddress: resolved.contractAddress } },
        create: {
          chain: "STARKNET",
          contractAddress: resolved.contractAddress,
          collectionId,
          name: resolved.name ?? undefined,
          symbol: resolved.symbol ?? undefined,
          baseUri: resolved.baseUri ?? undefined,
          owner: resolved.owner,
          startBlock: resolved.startBlock,
          metadataStatus: "PENDING",
        },
        update: {
          collectionId,
          name: resolved.name ?? undefined,
          symbol: resolved.symbol ?? undefined,
          owner: resolved.owner,
        },
      });

      worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: resolved.contractAddress });

      inserted++;
    }

    continuationToken = result.continuation_token;
  } while (continuationToken);

  log.info({ inserted, skipped }, "Registry backfill complete");
  return c.json({ data: { inserted, skipped } });
});

// ---------------------------------------------------------------------------
// POST /admin/indexer/reset-cursor — reset IndexerCursor to INDEXER_START_BLOCK
// Optional body: { chain?: "STARKNET" | ... } — defaults to the active mirror chain
// ---------------------------------------------------------------------------
admin.post("/indexer/reset-cursor", async (c) => {
  const { resetCursor } = await import("../../mirror/cursor.js");
  const { CHAIN } = await import("../../mirror/index.js");
  const body = await c.req.json().catch(() => ({}));
  const chain = (body?.chain ?? CHAIN) as typeof CHAIN;
  // Optional `block` param lets you advance/rewind the cursor to any block.
  const toBlock = body?.block != null ? BigInt(body.block) : undefined;
  await resetCursor(chain, toBlock);
  const { env } = await import("../../config/env.js");
  const lastBlock = toBlock != null ? toBlock.toString() : env.INDEXER_START_BLOCK;
  return c.json({ data: { chain, lastBlock } });
});

// ---------------------------------------------------------------------------
// GET /admin/claims — list collection claims with optional filters
// ---------------------------------------------------------------------------
admin.get("/claims", async (c) => {
  const status = c.req.query("status");
  const verificationMethod = c.req.query("verificationMethod");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");
  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (verificationMethod) where.verificationMethod = verificationMethod;

  const [claims, total] = await Promise.all([
    prisma.collectionClaim.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.collectionClaim.count({ where }),
  ]);

  return c.json({ claims, total, page, limit });
});

// ---------------------------------------------------------------------------
// PATCH /admin/claims/:id — approve or reject a manual claim
// ---------------------------------------------------------------------------
admin.patch("/claims/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { status, adminNotes, source } = body;

  if (!["APPROVED", "REJECTED"].includes(status)) {
    return c.json({ error: "status must be APPROVED or REJECTED" }, 400);
  }

  const claim = await prisma.collectionClaim.findUnique({ where: { id } });
  if (!claim) return c.json({ error: "Claim not found" }, 404);

  const updated = await prisma.collectionClaim.update({
    where: { id },
    data: { status, adminNotes, reviewedBy: "admin", reviewedAt: new Date() },
  });

  if (status === "APPROVED") {
    const normContract = normalizeAddress(claim.contractAddress);
    const normWallet = claim.claimantAddress ? normalizeAddress(claim.claimantAddress) : null;

    const existing = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normContract } },
    });

    if (!existing) {
      await prisma.collection.create({
        data: { chain: "STARKNET", contractAddress: normContract, source: source ?? "EXTERNAL", claimedBy: normWallet, metadataStatus: "PENDING", startBlock: BigInt(0) },
      });
      worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: normContract });
    } else {
      await prisma.collection.update({
        where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normContract } },
        data: { claimedBy: normWallet, ...(source ? { source } : {}) },
      });
    }
  }

  return c.json({ claim: updated });
});

// ---------------------------------------------------------------------------
// GET /admin/username-claims — list username claims with optional status filter
// ---------------------------------------------------------------------------
admin.get("/username-claims", async (c) => {
  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");
  const where = status ? { status: status as any } : {};

  const [claims, total] = await Promise.all([
    prisma.usernameClaim.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.usernameClaim.count({ where }),
  ]);

  return c.json({ claims, total, page, limit });
});

// ---------------------------------------------------------------------------
// PATCH /admin/username-claims/:id — approve or reject a username claim
// On approve: sets username on CreatorProfile and rejects any other pending
// claims for the same wallet or the same username.
// ---------------------------------------------------------------------------
admin.patch("/username-claims/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();
  const { status, adminNotes } = body;

  if (!["APPROVED", "REJECTED"].includes(status)) {
    return c.json({ error: "status must be APPROVED or REJECTED" }, 400);
  }

  const claim = await prisma.usernameClaim.findUnique({ where: { id } });
  if (!claim) return c.json({ error: "Claim not found" }, 404);
  if (claim.status !== "PENDING") return c.json({ error: "Claim is no longer pending" }, 409);

  const updated = await prisma.usernameClaim.update({
    where: { id },
    data: { status, adminNotes: adminNotes ?? null, reviewedAt: new Date() },
  });

  if (status === "APPROVED") {
    // Write the approved username onto the creator's profile (upsert in case
    // they haven't created a profile record yet)
    await prisma.creatorProfile.upsert({
      where: { walletAddress: claim.walletAddress },
      create: { walletAddress: claim.walletAddress, chain: "STARKNET", username: claim.username },
      update: { username: claim.username },
    });

    // Reject any other pending claims from this wallet or for this username
    await prisma.usernameClaim.updateMany({
      where: {
        id: { not: id },
        status: "PENDING",
        OR: [{ walletAddress: claim.walletAddress }, { username: claim.username }],
      },
      data: { status: "REJECTED", adminNotes: "Superseded by approved claim", reviewedAt: new Date() },
    });

    if (claim.notifyEmail) {
      sendUsernameClaimApproved(claim.notifyEmail, claim.username).catch(() => {});
    }
  } else if (status === "REJECTED" && claim.notifyEmail) {
    sendUsernameClaimRejected(claim.notifyEmail, claim.username, adminNotes ?? null).catch(() => {});
  }

  return c.json({ claim: updated });
});

// ---------------------------------------------------------------------------
// GET /admin/collections — list collections with optional filters
// ---------------------------------------------------------------------------
admin.get("/collections", async (c) => {
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");
  const source = c.req.query("source");
  const metadataStatus = c.req.query("metadataStatus");
  const isKnownParam = c.req.query("isKnown");
  const search = c.req.query("search");

  const where: Record<string, unknown> = {};
  if (source) where.source = source;
  if (metadataStatus) where.metadataStatus = metadataStatus;
  if (isKnownParam !== undefined && isKnownParam !== "") where.isKnown = isKnownParam === "true";
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { contractAddress: search },
    ];
  }

  const [collections, total] = await Promise.all([
    prisma.collection.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.collection.count({ where }),
  ]);

  const serialized = collections.map(col => ({ ...col, startBlock: col.startBlock.toString() }));
  return c.json({ collections: serialized, total, page, limit });
});

// ---------------------------------------------------------------------------
// POST /admin/orders/:orderHash/resync — re-fetch order details from chain and fix price
// ---------------------------------------------------------------------------
admin.post("/orders/:orderHash/resync", async (c) => {
  const orderHash = c.req.param("orderHash");
  const order = await prisma.order.findFirst({ where: { orderHash } });
  if (!order) return c.json({ error: "Order not found" }, 404);

  await prisma.$transaction(async (tx) => {
    await handleOrderCreated(
      { type: "OrderCreated", orderHash, offerer: order.offerer, blockNumber: order.createdBlockNumber, txHash: order.createdTxHash ?? "", logIndex: 0 },
      tx,
      order.chain
    );
  });

  const updated = await prisma.order.findFirst({ where: { orderHash } });
  return c.json({ priceRaw: updated?.priceRaw, priceFormatted: updated?.priceFormatted, currencySymbol: updated?.currencySymbol });
});

// ---------------------------------------------------------------------------
// GET /admin/reports — list reports, paginated, enriched with target name + image
// ---------------------------------------------------------------------------
admin.get("/reports", async (c) => {
  const { status, targetType, page = "1", limit = "20" } = c.req.query();

  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * limitNum;

  const where: Record<string, unknown> = {};
  if (status) {
    const statuses = status
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    where.status = statuses.length === 1 ? statuses[0] : ({ in: statuses } as any);
  }
  if (targetType) where.targetType = targetType;

  const [rawReports, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNum,
    }),
    prisma.report.count({ where }),
  ]);

  // Batch enrich: one query per type to avoid N+1
  const collectionContracts = [
    ...new Set(
      rawReports
        .filter((r) => r.targetType === "COLLECTION" && r.targetContract)
        .map((r) => r.targetContract!)
    ),
  ];
  const tokenKeys = rawReports
    .filter((r) => r.targetType === "TOKEN" && r.targetContract && r.targetTokenId)
    .map((r) => ({ contractAddress: r.targetContract!, tokenId: r.targetTokenId! }));

  const [collectionMeta, tokenMeta] = await Promise.all([
    collectionContracts.length > 0
      ? prisma.collection.findMany({
          where: { contractAddress: { in: collectionContracts } },
          select: { contractAddress: true, name: true, image: true },
        })
      : Promise.resolve([]),
    tokenKeys.length > 0
      ? prisma.token.findMany({
          where: {
            OR: tokenKeys.map((k) => ({
              contractAddress: k.contractAddress,
              tokenId: k.tokenId,
            })),
          },
          select: { contractAddress: true, tokenId: true, name: true, image: true },
        })
      : Promise.resolve([]),
  ]);

  const colByContract = new Map(collectionMeta.map((c) => [c.contractAddress, c]));
  const tokenByKey = new Map(
    tokenMeta.map((t) => [`${t.contractAddress}:${t.tokenId}`, t])
  );

  const enriched = rawReports.map((r) => {
    let targetName: string | null = null;
    let targetImage: string | null = null;

    if (r.targetType === "COLLECTION" && r.targetContract) {
      const col = colByContract.get(r.targetContract);
      targetName = col?.name ?? null;
      targetImage = col?.image ?? null;
    } else if (r.targetType === "TOKEN" && r.targetContract && r.targetTokenId) {
      const tok = tokenByKey.get(`${r.targetContract}:${r.targetTokenId}`);
      targetName = tok?.name ?? null;
      targetImage = tok?.image ?? null;
    }

    return { ...r, targetName, targetImage };
  });

  return c.json({ reports: enriched, total, page: pageNum, pageSize: limitNum });
});

// ---------------------------------------------------------------------------
// PATCH /admin/reports/:id — review action with atomic visibility side effects
// ---------------------------------------------------------------------------
admin.patch("/reports/:id", async (c) => {
  const { id } = c.req.param();

  let body: { status?: string; adminNotes?: string; reviewedBy?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const validStatuses = [
    "PENDING",
    "UNDER_REVIEW",
    "HIDDEN",
    "DISMISSED",
    "RESTORED",
  ] as const;

  if (!body.status || !validStatuses.includes(body.status as (typeof validStatuses)[number])) {
    return c.json({ error: "status is required and must be a valid ReportStatus" }, 400);
  }
  const newStatus = body.status as (typeof validStatuses)[number];

  if (
    (newStatus === "HIDDEN" || newStatus === "DISMISSED") &&
    !body.adminNotes?.trim()
  ) {
    return c.json(
      { error: "adminNotes are required for HIDDEN and DISMISSED actions" },
      400
    );
  }

  const report = await prisma.report.findUnique({ where: { id } });
  if (!report) return c.json({ error: "Report not found" }, 404);

  // Atomic: update report status + apply visibility side effect in one transaction
  await prisma.$transaction(async (tx) => {
    await tx.report.update({
      where: { id },
      data: {
        status: newStatus,
        adminNotes: body.adminNotes?.trim() || undefined,
        reviewedBy: body.reviewedBy || undefined,
        reviewedAt: new Date(),
      },
    });

    if (newStatus === "HIDDEN") {
      if (report.targetType === "COLLECTION" && report.targetContract) {
        await tx.collection.updateMany({
          where: { contractAddress: report.targetContract, chain: report.chain },
          data: { isHidden: true },
        });
      } else if (
        report.targetType === "TOKEN" &&
        report.targetContract &&
        report.targetTokenId
      ) {
        await tx.token.updateMany({
          where: {
            contractAddress: report.targetContract,
            tokenId: report.targetTokenId,
            chain: report.chain,
          },
          data: { isHidden: true },
        });
      } else if (report.targetType === "CREATOR" && report.targetAddress) {
        // Upsert is idempotent — safe if creator already hidden by another report
        await tx.hiddenCreator.upsert({
          where: {
            chain_address: { chain: report.chain, address: report.targetAddress },
          },
          create: { chain: report.chain, address: report.targetAddress },
          update: {},
        });
      }
    } else if (newStatus === "RESTORED") {
      // Only clear visibility if NO other HIDDEN reports exist for this target
      const otherHidden = await tx.report.count({
        where: {
          targetKey: report.targetKey,
          status: "HIDDEN",
          id: { not: id },
        },
      });

      if (otherHidden === 0) {
        if (report.targetType === "COLLECTION" && report.targetContract) {
          await tx.collection.updateMany({
            where: { contractAddress: report.targetContract, chain: report.chain },
            data: { isHidden: false },
          });
        } else if (
          report.targetType === "TOKEN" &&
          report.targetContract &&
          report.targetTokenId
        ) {
          await tx.token.updateMany({
            where: {
              contractAddress: report.targetContract,
              tokenId: report.targetTokenId,
              chain: report.chain,
            },
            data: { isHidden: false },
          });
        } else if (report.targetType === "CREATOR" && report.targetAddress) {
          await tx.hiddenCreator.deleteMany({
            where: { chain: report.chain, address: report.targetAddress },
          });
        }
      }
    }
  });

  const updated = await prisma.report.findUnique({ where: { id } });
  return c.json({ data: updated });
});

// ---------------------------------------------------------------------------
// PATCH /admin/creators/:oldAddress/fix-wallet — correct a wrong wallet address
// Updates walletAddress on CreatorProfile, UsernameClaim, and User records.
// ---------------------------------------------------------------------------
admin.patch("/creators/:oldAddress/fix-wallet", async (c) => {
  const oldRaw = c.req.param("oldAddress");
  const body = await c.req.json();
  const newRaw = body.newAddress as string | undefined;
  if (!newRaw) return c.json({ error: "newAddress required" }, 400);

  const oldAddr = normalizeAddress(oldRaw);
  const newAddr = normalizeAddress(newRaw);

  const [profileUpdate, claimUpdate] = await Promise.all([
    prisma.creatorProfile.updateMany({
      where: { walletAddress: oldAddr },
      data: { walletAddress: newAddr },
    }),
    prisma.usernameClaim.updateMany({
      where: { walletAddress: oldAddr },
      data: { walletAddress: newAddr },
    }),
  ]);

  log.info({ oldAddr, newAddr, profileUpdate, claimUpdate }, "Creator wallet address corrected");
  return c.json({ data: { oldAddr, newAddr, profileUpdate, claimUpdate } });
});

// ---------------------------------------------------------------------------
// GET /admin/comments — list comments (newest first, optional filters)
// Query params: ?hidden=true|false, ?author=0x..., ?contract=0x..., ?page=1, ?limit=50
// ---------------------------------------------------------------------------
admin.get("/comments", async (c) => {
  const hidden = c.req.query("hidden");
  const author = c.req.query("author");
  const contract = c.req.query("contract");
  const page = Math.max(1, Number(c.req.query("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "50")));

  const where: Record<string, unknown> = {};
  if (hidden === "true") where.isHidden = true;
  if (hidden === "false") where.isHidden = false;
  if (author) where.author = normalizeAddress(author);
  if (contract) where.contractAddress = normalizeAddress(contract);

  const [comments, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.comment.count({ where }),
  ]);

  return c.json({ data: comments, meta: { page, limit, total } });
});

// ---------------------------------------------------------------------------
// PATCH /admin/comments/:id/hide
// ---------------------------------------------------------------------------
admin.patch("/comments/:id/hide", async (c) => {
  const { id } = c.req.param();
  const comment = await prisma.comment.findUnique({ where: { id } });
  if (!comment) return c.json({ error: "Comment not found" }, 404);

  const updated = await prisma.comment.update({
    where: { id },
    data: { isHidden: true },
  });
  log.info({ id }, "Comment hidden by admin");
  return c.json({ data: updated });
});

// ---------------------------------------------------------------------------
// PATCH /admin/comments/:id/show
// ---------------------------------------------------------------------------
admin.patch("/comments/:id/show", async (c) => {
  const { id } = c.req.param();
  const comment = await prisma.comment.findUnique({ where: { id } });
  if (!comment) return c.json({ error: "Comment not found" }, 404);

  const updated = await prisma.comment.update({
    where: { id },
    data: { isHidden: false },
  });
  log.info({ id }, "Comment restored by admin");
  return c.json({ data: updated });
});

// ---------------------------------------------------------------------------
// PATCH /admin/remix-offers/:id — override creatorAddress when token transfer caused stale state
// ---------------------------------------------------------------------------
admin.patch("/remix-offers/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  if (!body.creatorAddress) {
    return c.json({ error: "creatorAddress is required" }, 400);
  }

  const updated = await prisma.remixOffer.update({
    where: { id },
    data: { creatorAddress: normalizeAddress(body.creatorAddress) },
  });

  return c.json({ data: { id: updated.id, creatorAddress: updated.creatorAddress } });
});

// ---------------------------------------------------------------------------
// POST /admin/pop/allowlist — bulk-add wallets to a POP collection allowlist
// Body: { collectionAddress: string, addresses: string[] }
// Upserts allowed=true for each address. Use DELETE endpoint or on-chain remove_from_allowlist
// to revoke individual entries.
// ---------------------------------------------------------------------------
admin.post("/pop/allowlist", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { collectionAddress, addresses } = body as { collectionAddress?: string; addresses?: unknown };

  if (!collectionAddress || !Array.isArray(addresses) || addresses.length === 0) {
    return c.json({ error: "collectionAddress and addresses[] are required" }, 400);
  }

  const MAX_BATCH = 10_000;
  if (addresses.length > MAX_BATCH) {
    return c.json({ error: `addresses[] exceeds maximum batch size of ${MAX_BATCH}` }, 400);
  }

  const normalizedCollection = normalizeAddress(collectionAddress);

  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = (addresses as string[]).slice(i, i + CHUNK);
    const result = await prisma.popAllowlist.createMany({
      data: chunk.map((addr) => ({
        chain: "STARKNET" as const,
        collectionAddress: normalizedCollection,
        walletAddress: normalizeAddress(addr),
        allowed: true,
      })),
      skipDuplicates: true,
    });
    inserted += result.count;
  }

  // Re-enable any previously disabled entries
  await prisma.popAllowlist.updateMany({
    where: {
      chain: "STARKNET",
      collectionAddress: normalizedCollection,
      walletAddress: { in: (addresses as string[]).map((a) => normalizeAddress(a)) },
      allowed: false,
    },
    data: { allowed: true },
  });

  log.info({ collectionAddress: normalizedCollection, total: addresses.length, inserted }, "POP allowlist updated");
  return c.json({ data: { collectionAddress: normalizedCollection, total: addresses.length, inserted } });
});

// DELETE /admin/pop/allowlist — remove wallets from a POP collection allowlist
// Body: { collectionAddress: string, addresses: string[] }
admin.delete("/pop/allowlist", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { collectionAddress, addresses } = body as { collectionAddress?: string; addresses?: unknown };

  if (!collectionAddress || !Array.isArray(addresses) || addresses.length === 0) {
    return c.json({ error: "collectionAddress and addresses[] are required" }, 400);
  }

  const normalizedCollection = normalizeAddress(collectionAddress);
  const normalizedAddresses = (addresses as string[]).map((a) => normalizeAddress(a));

  const result = await prisma.popAllowlist.updateMany({
    where: {
      chain: "STARKNET",
      collectionAddress: normalizedCollection,
      walletAddress: { in: normalizedAddresses },
    },
    data: { allowed: false },
  });

  log.info({ collectionAddress: normalizedCollection, removed: result.count }, "POP allowlist entries disabled");
  return c.json({ data: { collectionAddress: normalizedCollection, removed: result.count } });
});

export default admin;

