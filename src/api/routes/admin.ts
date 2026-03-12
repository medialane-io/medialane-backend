import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { authMiddleware } from "../middleware/auth.js";
import prisma from "../../db/client.js";
import { generateApiKey } from "../../utils/apiKey.js";
import { handleMetadataFetch } from "../../orchestrator/metadata.js";
import { handleCollectionMetadataFetch } from "../../orchestrator/collectionMetadata.js";
import { enqueueJob } from "../../orchestrator/queue.js";
import { createLogger } from "../../utils/logger.js";

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

  await prisma.auditLog.create({
    data: {
      tenantId: tenant.id,
      actorType: "admin",
      actor: "system",
      action: "TENANT_CREATED",
      detail: { name, email, plan },
    },
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

  await prisma.auditLog.create({
    data: {
      tenantId: id,
      actorType: "admin",
      actor: "system",
      action: "TENANT_UPDATED",
      detail: parsed.data,
    },
  });

  return c.json({ data: { id, plan: updated.plan, status: updated.status } });
});

// ---------------------------------------------------------------------------
// GET /admin/usage — usage stats
// ---------------------------------------------------------------------------
admin.get("/usage", async (c) => {
  const tenantId = c.req.query("tenantId");
  const daysParam = parseInt(c.req.query("days") ?? "30", 10);
  const days = Math.min(Number.isFinite(daysParam) ? daysParam : 30, 90);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);

  const tenantFilter = tenantId
    ? Prisma.sql`AND "tenantId" = ${tenantId}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<
    { tenant_id: string; day: Date; requests: bigint }[]
  >`
    SELECT
      "tenantId"   AS tenant_id,
      date_trunc('day', "createdAt") AS day,
      COUNT(*)     AS requests
    FROM "UsageLog"
    WHERE "createdAt" >= ${since}
      ${tenantFilter}
    GROUP BY "tenantId", day
    ORDER BY day DESC
  `;

  return c.json({
    data: rows.map((r) => ({
      tenantId: r.tenant_id,
      day: (r.day as Date).toISOString().slice(0, 10),
      requests: Number(r.requests),
    })),
  });
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

  await prisma.auditLog.create({
    data: {
      tenantId: id,
      actorType: "admin",
      actor: "system",
      action: "API_KEY_CREATED",
      detail: { keyId: apiKey.id, label },
    },
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

  await prisma.auditLog.create({
    data: {
      tenantId: apiKey.tenantId,
      actorType: "admin",
      actor: "system",
      action: "API_KEY_REVOKED",
      detail: { keyId, prefix: apiKey.prefix },
    },
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
  const contractAddress = rawAddr.toLowerCase();

  const col = await prisma.collection.upsert({
    where: { chain_contractAddress: { chain: chain as any, contractAddress } },
    create: { chain: chain as any, contractAddress, metadataStatus: "PENDING", startBlock: BigInt(startBlock) },
    update: {},
  });

  await enqueueJob("COLLECTION_METADATA_FETCH", { chain, contractAddress });

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
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract.toLowerCase() } },
  });
  if (!col) return c.json({ error: "Collection not found" }, 404);

  const updated = await prisma.collection.update({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract.toLowerCase() } },
    data: parsed.data,
  });

  return c.json({ data: { contractAddress: updated.contractAddress, name: updated.name, isKnown: updated.isKnown } });
});

// ---------------------------------------------------------------------------
// POST /admin/collections/:contract/refresh — force sync collection metadata
// ---------------------------------------------------------------------------
admin.post("/collections/:contract/refresh", async (c) => {
  const { contract } = c.req.param();
  try {
    await handleCollectionMetadataFetch({ chain: "STARKNET", contractAddress: contract.toLowerCase() });
    const col = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: contract.toLowerCase() } },
    });
    return c.json({ data: { metadataStatus: col?.metadataStatus, name: col?.name, symbol: col?.symbol } });
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
    await enqueueJob("COLLECTION_METADATA_FETCH", {
      chain: col.chain,
      contractAddress: col.contractAddress,
    });
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
import { normalizeAddress } from "../../utils/starknet.js";

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

      await enqueueJob("COLLECTION_METADATA_FETCH", {
        chain: "STARKNET",
        contractAddress: resolved.contractAddress,
      });

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

export default admin;
