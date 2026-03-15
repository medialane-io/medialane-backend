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
import { normalizeAddress } from "../../utils/starknet.js";
import { handleOrderCreated } from "../../mirror/handlers/orderCreated.js";

const log = createLogger("routes:admin");
const admin = new Hono();

// All admin routes require the admin secret
admin.use("*", authMiddleware);

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
  try {
    await handleMetadataFetch({ chain: "STARKNET", contractAddress: contract.toLowerCase(), tokenId });
    const token = await prisma.token.findUnique({
      where: { chain_contractAddress_tokenId: { chain: "STARKNET", contractAddress: contract.toLowerCase(), tokenId } },
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
  const orderHash = normalizeAddress(c.req.param("orderHash"));
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

export default admin;
