import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../../middleware/adminSecretAuth.js";
import prisma from "../../../db/client.js";
import { generateApiKey } from "../../../utils/apiKey.js";
import { handleMetadataFetch } from "../../../orchestrator/metadata.js";
import { handleCollectionMetadataFetch } from "../../../orchestrator/collectionMetadata.js";
import { handleStatsUpdate } from "../../../orchestrator/stats.js";
import { runTransferFollowups } from "../../../orchestrator/transferFollowup.js";
import { worker } from "../../../orchestrator/worker.js";
import { createLogger } from "../../../utils/logger.js";
import { sendUsernameClaimApproved, sendUsernameClaimRejected } from "../../../utils/mailer.js";
import { normalizeAddress, normalizeHash, callRpc } from "../../../utils/starknet.js";
import { upsertCollectionFromFactory } from "../../../utils/collection.js";
import { upsertCoin } from "../../../utils/coin.js";
import { handleOrderCreated, handleOrderCreated1155 } from "../../../mirror/handlers/orderCreated.js";
import { pollContractEvents, getLatestBlock } from "../../../mirror/poller.js";
import { dispatchTransfer } from "../../../mirror/handlers/transfer.js";
import { parseEvents } from "../../../mirror/parser.js";
import { fetchMarketplaceReceiptEvents, fetchReceiptEvents } from "../../../utils/txVerifier.js";
import { ORDER_CREATED_SELECTOR, ZERO_ADDRESS, getTokenByAddress, UNRUG_FACTORY_CONTRACT, STARKNET_COLLECTION_721_CONTRACT, COLLECTION_CREATED_SELECTOR, TRANSFER_SELECTOR, TRANSFER_SINGLE_SELECTOR, TRANSFER_BATCH_SELECTOR } from "../../../config/constants.js";
import { num, shortString } from "starknet";

/** Decode a felt252 short string (OZ 0.8 ERC-20 name/symbol); null on failure. */
function decodeShortStr(felt: string): string | null {
  try {
    const s = shortString.decodeShortString(felt);
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}
import type { ParsedTransfer, ParsedTransferBatch, ParsedTransferSingle } from "../../../types/marketplace.js";

import { InMemoryRateLimitStore } from "../../middleware/rateLimit.js";
import { toErrorMessage } from "../../../utils/error.js";
import { getClientIp } from "./_shared.js";
import { resolveCollectionCreated, decodeCollectionCreatedEvent } from "../../../mirror/handlers/collectionCreated.js";
import { COLLECTION_721_START_BLOCK } from "../../../config/constants.js";
import { buildAdminCoinWhere } from "../coins.filters.js";

const log = createLogger("routes:admin");

export function registerCollectionRoutes(admin: Hono) {
// POST /admin/tokens/:contract/:tokenId/refresh — force sync metadata
// ---------------------------------------------------------------------------
admin.post("/tokens/:contract/:tokenId/refresh", async (c) => {
  const { contract, tokenId } = c.req.param();
  const contractAddress = normalizeAddress("STARKNET", contract);

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
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/tokens/:contract/:tokenId/rebuild-balances — replay indexed
// transfers for one token and replace TokenBalance with deterministic state.
// ---------------------------------------------------------------------------
admin.post("/tokens/:contract/:tokenId/rebuild-balances", async (c) => {
  const { contract, tokenId } = c.req.param();
  const contractAddress = normalizeAddress("STARKNET", contract);

  const result = await prisma.$transaction(async (tx) => {
    const transfers = await tx.transfer.findMany({
      where: { chain: "STARKNET", contractAddress, tokenId },
      orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }],
      select: {
        id: true,
        txHash: true,
        logIndex: true,
        contractAddress: true,
        tokenId: true,
        fromAddress: true,
        toAddress: true,
        amount: true,
        blockNumber: true,
      },
    });

    const uniqueTransfers = new Map<string, (typeof transfers)[number]>();
    const duplicateTransferIds: string[] = [];
    const txHashUpdates: Array<{ id: string; txHash: string }> = [];

    for (const transfer of transfers) {
      const normalizedTxHash = normalizeHash(transfer.txHash);
      const key = [
        normalizedTxHash,
        transfer.contractAddress,
        transfer.tokenId,
        transfer.fromAddress,
        transfer.toAddress,
        transfer.amount,
      ].join(":");
      const existing = uniqueTransfers.get(key);

      if (!existing) {
        uniqueTransfers.set(key, transfer);
        if (transfer.txHash !== normalizedTxHash) {
          txHashUpdates.push({ id: transfer.id, txHash: normalizedTxHash });
        }
        continue;
      }

      const existingIsCanonical = existing.txHash === normalizedTxHash;
      const transferIsCanonical = transfer.txHash === normalizedTxHash;
      if (!existingIsCanonical && transferIsCanonical) {
        duplicateTransferIds.push(existing.id);
        uniqueTransfers.set(key, transfer);
      } else {
        duplicateTransferIds.push(transfer.id);
      }
    }

    if (duplicateTransferIds.length > 0) {
      await tx.transfer.deleteMany({ where: { id: { in: duplicateTransferIds } } });
    }

    for (const { id, txHash } of txHashUpdates) {
      if (!duplicateTransferIds.includes(id)) {
        await tx.transfer.update({ where: { id }, data: { txHash } });
      }
    }

    const balances = new Map<string, bigint>();
    const replayTransfers = [...uniqueTransfers.values()].sort((a, b) => {
      const blockDelta = a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0;
      return blockDelta || a.logIndex - b.logIndex;
    });

    for (const transfer of replayTransfers) {
      const amount = BigInt(transfer.amount);
      const from = transfer.fromAddress;
      const to = transfer.toAddress;

      if (from !== ZERO_ADDRESS) {
        const next = (balances.get(from) ?? 0n) - amount;
        balances.set(from, next > 0n ? next : 0n);
      }
      if (to !== ZERO_ADDRESS) {
        balances.set(to, (balances.get(to) ?? 0n) + amount);
      }
    }

    await tx.tokenBalance.deleteMany({
      where: { chain: "STARKNET", contractAddress, tokenId },
    });

    const rows = [...balances.entries()]
      .filter(([, amount]) => amount > 0n)
      .map(([owner, amount]) => ({
        chain: "STARKNET" as const,
        contractAddress,
        tokenId,
        owner,
        amount: amount.toString(),
      }));

    if (rows.length > 0) {
      await tx.tokenBalance.createMany({ data: rows });
    }

    return {
      transferCount: replayTransfers.length,
      duplicateTransferCount: duplicateTransferIds.length,
      normalizedTransferCount: txHashUpdates.length,
      balances: rows,
    };
  }, { timeout: 60000 });

  await handleStatsUpdate({ chain: "STARKNET", contractAddress });

  log.info({ contractAddress, tokenId, ...result }, "Token balances rebuilt from transfer ledger");
  return c.json({ data: { contractAddress, tokenId, ...result } });
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
    // Standard is required for create — every collection has a real ABI surface,
    // there's no longer an UNKNOWN fallback.
    standard: z.enum(["ERC721", "ERC1155"]),
    // Caller may pass a service ID; otherwise we default to external-<standard>.
    service: z.string().optional(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const { contractAddress: rawAddr, chain, startBlock, standard, service } = parsed.data;
  const contractAddress = normalizeAddress("STARKNET", rawAddr);

  // service is required on Collection. Default to external-<standard>.
  const resolvedService =
    service ?? (standard === "ERC1155" ? "external-erc1155" : "external-erc721");

  const col = await prisma.collection.upsert({
    where: { chain_contractAddress: { chain: chain as any, contractAddress } },
    create: {
      chain: chain as any,
      contractAddress,
      metadataStatus: "PENDING",
      startBlock: BigInt(startBlock),
      service: resolvedService,
      standard,
    },
    update: {
      standard,
      ...(service ? { service } : {}),
    },
  });

  worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: chain as any, contractAddress });

  log.info({ contractAddress, chain }, "Collection registered via admin");

  return c.json({ data: { id: col.id, contractAddress, chain, metadataStatus: col.metadataStatus } }, 201);
});

// ---------------------------------------------------------------------------
// POST /admin/coins/add-external — add an external (unrug/partner) ERC-20 coin.
//
// The ERC-20 sibling of POST /v1/coins/sync: `POST /admin/collections` can't
// register a coin (its `standard` enum is ERC721/ERC1155 only), and
// `/v1/coins/sync` only accepts Medialane-factory Creator Coins. This verifies
// the address via the Unruggable factory's `is_memecoin`, reads name/symbol
// on-chain, and upserts a Coin(service "external-erc20"). Idempotent. Admin-gated.
// (Coins live in the Coin table since the 2026-06-14 split — never Collection.)
//
// Body: { contractAddress: string, owner?: string, startBlock?: number }
// ---------------------------------------------------------------------------
admin.post("/coins/add-external", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      contractAddress: z.string().min(3),
      owner: z.string().optional(),
      startBlock: z.number().optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: "contractAddress required" }, 400);

  if (!UNRUG_FACTORY_CONTRACT) return c.json({ error: "Unrug factory not configured" }, 503);
  const contractAddress = normalizeAddress("STARKNET", parsed.data.contractAddress);

  try {
    // Gate: only genuine Unruggable-launched memecoins.
    const verify = await callRpc((p) =>
      p.callContract({ contractAddress: UNRUG_FACTORY_CONTRACT, entrypoint: "is_memecoin", calldata: [contractAddress] })
    );
    const isMemecoin = verify.length > 0 && BigInt(verify[0] ?? "0x0") !== 0n;
    if (!isMemecoin) {
      return c.json({ error: "Address is not an unrug memecoin (is_memecoin = false)" }, 400);
    }

    // ERC-20 metadata (OZ 0.8 → felt252 short strings; decimals → u8). External
    // coins can have non-18 decimals, so read it rather than assume.
    const [nameRes, symbolRes, decRes] = await Promise.all([
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "name", calldata: [] })),
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "symbol", calldata: [] })),
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "decimals", calldata: [] })),
    ]);
    const name = decodeShortStr(nameRes[0] ?? "0x0");
    const symbol = decodeShortStr(symbolRes[0] ?? "0x0");
    const decimals = decRes[0] != null ? Number(BigInt(decRes[0])) : 18;

    await upsertCoin(prisma, {
      chain: "STARKNET",
      contractAddress,
      service: "external-erc20",
      name,
      symbol,
      decimals,
      creator: parsed.data.owner ? normalizeAddress("STARKNET", parsed.data.owner) : null,
      startBlock: BigInt(parsed.data.startBlock ?? 0),
    });

    const coin = await prisma.coin.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    });
    log.info({ contractAddress, name, symbol }, "External coin added via admin");
    return c.json({
      data: coin
        ? { ...coin, startBlock: coin.startBlock.toString() }
        : { contractAddress, service: "external-erc20", standard: "ERC20", name, symbol },
    }, 201);
  } catch (err) {
    log.error({ err, contractAddress }, "external coin add failed");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/coins — list coins (includes hidden; admins see everything).
// ?service=&search=&page=&limit=. Mirrors GET /admin/collections.
// ---------------------------------------------------------------------------
admin.get("/coins", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1"));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20")));
  const where = buildAdminCoinWhere({
    service: c.req.query("service") || undefined,
    search: c.req.query("search") || undefined,
  });
  const [rows, total] = await Promise.all([
    prisma.coin.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.coin.count({ where }),
  ]);
  const coins = rows.map((coin) => ({ ...coin, startBlock: coin.startBlock.toString() }));
  return c.json({ coins, total, page, limit });
});

// ---------------------------------------------------------------------------
// PATCH /admin/coins/:contract — admin edit (broader than the creator route).
// `isHidden` is the durable removal lever (no hard delete — a Coin is a
// rebuildable on-chain projection; see spec 2026-06-15).
// ---------------------------------------------------------------------------
admin.patch("/coins/:contract", async (c) => {
  const contractAddress = normalizeAddress("STARKNET", c.req.param("contract"));
  const schema = z.object({
    name:        z.string().optional(),
    symbol:      z.string().optional(),
    description: z.string().optional(),
    image:       z.string().optional(),
    service:     z.string().optional(),
    creator:     z.string().optional(),
    isHidden:    z.boolean().optional(),
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const coin = await prisma.coin.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
  });
  if (!coin) return c.json({ error: "Coin not found" }, 404);

  const updated = await prisma.coin.update({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    data: {
      ...parsed.data,
      ...(parsed.data.creator ? { creator: normalizeAddress("STARKNET", parsed.data.creator) } : {}),
    },
  });
  log.info({ contractAddress }, "Coin updated via admin");
  return c.json({ data: { contractAddress: updated.contractAddress, name: updated.name, symbol: updated.symbol, isHidden: updated.isHidden } });
});

// ---------------------------------------------------------------------------
// POST /admin/coins/:contract/refresh — re-read on-chain ERC-20 metadata
// (name/symbol/decimals) and upsert. upsertCoin's update clause never touches
// isHidden, so a hidden coin stays hidden across refresh.
// ---------------------------------------------------------------------------
admin.post("/coins/:contract/refresh", async (c) => {
  const contractAddress = normalizeAddress("STARKNET", c.req.param("contract"));
  const coin = await prisma.coin.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
  });
  if (!coin) return c.json({ error: "Coin not found" }, 404);

  try {
    const [nameRes, symbolRes, decRes] = await Promise.all([
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "name", calldata: [] })),
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "symbol", calldata: [] })),
      callRpc((p) => p.callContract({ contractAddress, entrypoint: "decimals", calldata: [] })),
    ]);
    const name = decodeShortStr(nameRes[0] ?? "0x0");
    const symbol = decodeShortStr(symbolRes[0] ?? "0x0");
    const decimals = decRes[0] != null ? Number(BigInt(decRes[0])) : coin.decimals;

    await upsertCoin(prisma, {
      chain: "STARKNET",
      contractAddress,
      service: coin.service,
      name,
      symbol,
      decimals,
      creator: coin.creator,
      startBlock: coin.startBlock,
    });
    log.info({ contractAddress, name, symbol, decimals }, "Coin metadata refreshed via admin");
    return c.json({ data: { name, symbol, decimals } });
  } catch (err) {
    log.error({ err, contractAddress }, "coin refresh failed");
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// PATCH /admin/collections/:contract — update collection fields (name, description, image, isFeatured)
// ---------------------------------------------------------------------------
admin.patch("/collections/:contract", async (c) => {
  const { contract } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const schema = z.object({
    name:         z.string().optional(),
    symbol:       z.string().optional(),
    description:  z.string().optional(),
    image:        z.string().optional(),
    isFeatured:   z.boolean().optional(),
    isHidden:     z.boolean().optional(),
    owner:        z.string().optional(),
    collectionId: z.string().optional(),
    service:      z.string().optional(),
    standard:     z.enum(["ERC721", "ERC1155"]).optional(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normalizeAddress("STARKNET", contract) } },
  });
  if (!col) return c.json({ error: "Collection not found" }, 404);

  const updateData = {
    ...parsed.data,
    ...(parsed.data.owner ? { owner: normalizeAddress("STARKNET", parsed.data.owner) } : {}),
  };
  const updated = await prisma.collection.update({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress: normalizeAddress("STARKNET", contract) } },
    data: updateData,
  });

  return c.json({ data: { contractAddress: updated.contractAddress, name: updated.name, isFeatured: updated.isFeatured } });
});

// ---------------------------------------------------------------------------
// DELETE /admin/collections/:contract — soft-delete (sets isHidden + records deletion metadata)
// ---------------------------------------------------------------------------
admin.delete("/collections/:contract", async (c) => {
  const { contract } = c.req.param();
  const contractAddress = normalizeAddress("STARKNET", contract);

  const col = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    select: { id: true, deletedAt: true },
  });
  if (!col) return c.json({ error: "Collection not found" }, 404);
  if (col.deletedAt) return c.json({ error: "Collection already deleted" }, 409);

  const ip = getClientIp(c);
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
  const contractAddress = normalizeAddress("STARKNET", contract);
  try {
    // Reset status so the alreadyComplete guard in handleCollectionMetadataFetch
    // does not short-circuit — makes this endpoint a true force-refresh.
    await prisma.collection.updateMany({
      where: { chain: "STARKNET", contractAddress },
      data: { metadataStatus: "PENDING" },
    });
    await handleCollectionMetadataFetch({ chain: "STARKNET", contractAddress });
    worker.enqueue({ type: "STATS_UPDATE", chain: "STARKNET", contractAddress });
    const col = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    });
    return c.json({ data: { metadataStatus: col?.metadataStatus, name: col?.name, symbol: col?.symbol } });
  } catch (err) {
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/collections/:contract/stats-refresh — force sync stats + backfill image/description
// ---------------------------------------------------------------------------
admin.post("/collections/:contract/stats-refresh", async (c) => {
  const { contract } = c.req.param();
  const contractAddress = normalizeAddress("STARKNET", contract);
  try {
    await handleStatsUpdate({ chain: "STARKNET", contractAddress });
    const col = await prisma.collection.findUnique({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress } },
    });
    return c.json({ data: { totalSupply: col?.totalSupply, holderCount: col?.holderCount, image: col?.image, description: col?.description } });
  } catch (err) {
    return c.json({ error: toErrorMessage(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/collections/:contract/backfill-transfers — scan historical Transfer events
// ---------------------------------------------------------------------------
// Fetches Transfer, TransferSingle, and TransferBatch events for the contract.
// Works for both ERC-721 and ERC-1155 collections.
// Use this when a collection was registered after its mints already happened.
admin.post("/collections/:contract/backfill-transfers", async (c) => {
  const { contract } = c.req.param();
  const contractAddress = normalizeAddress("STARKNET", contract);

  try {
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      fromBlock: z.number().int().min(0).default(0),
      toBlock:   z.number().int().min(0).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);

    const fromBlock   = parsed.data.fromBlock;
    const toBlock     = parsed.data.toBlock ?? await getLatestBlock();

    if (fromBlock > toBlock) {
      return c.json({ error: `fromBlock (${fromBlock}) must be ≤ toBlock (${toBlock})` }, 400);
    }

    log.info({ contractAddress, fromBlock, toBlock }, "Starting Transfer backfill");

    const rawEvents = await pollContractEvents({
      address: contractAddress,
      fromBlock,
      toBlock,
      keys: [[num.toHex(TRANSFER_SELECTOR), num.toHex(TRANSFER_SINGLE_SELECTOR), num.toHex(TRANSFER_BATCH_SELECTOR)]],
      maxPages: 100,
    });
    const parsedEvents = parseEvents(rawEvents);
    const transferEvents = parsedEvents.filter(
      (e) => e.type === "Transfer" || e.type === "TransferSingle" || e.type === "TransferBatch"
    );

    let inserted = 0;
    let skipped  = 0;

    for (const event of transferEvents) {
      try {
        await prisma.$transaction(async (tx) => {
          await dispatchTransfer(event, tx, "STARKNET");
        });
        inserted++;
      } catch (err: unknown) {
        // P2002 = unique constraint — already processed
        if ((err as { code?: string }).code === "P2002") {
          skipped++;
        } else {
          log.warn({ err, eventType: event.type }, "Transfer backfill row error — skipping");
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
  } catch (err) {
    const error = toErrorMessage(err);
    log.error({ err, contractAddress }, "Transfer backfill failed");
    return c.json({ error }, 500);
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

admin.post("/collections/backfill-registry", async (c) => {
  const latestBlock = await getLatestBlock();
  const events = await pollContractEvents({
    address: STARKNET_COLLECTION_721_CONTRACT,
    fromBlock: COLLECTION_721_START_BLOCK,
    toBlock: latestBlock,
    keys: [[num.toHex(COLLECTION_CREATED_SELECTOR)]],
  });
  let inserted = 0;
  let skipped = 0;

  for (const event of events) {
    const decoded = decodeCollectionCreatedEvent(event);
    if (!decoded) continue;
    const { collectionId, owner } = decoded;
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
        service: "mip-erc721",
        standard: "ERC721",
        metadataStatus: "PENDING",
      },
      update: {
        collectionId,
        name: resolved.name ?? undefined,
        symbol: resolved.symbol ?? undefined,
        owner: resolved.owner,
        service: "mip-erc721",
        standard: "ERC721",
      },
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: resolved.contractAddress });

    inserted++;
  }

  log.info({ inserted, skipped }, "Registry backfill complete");
  return c.json({ data: { inserted, skipped } });
});

// ---------------------------------------------------------------------------
// POST /admin/indexer/reset-cursor — reset IndexerCursor to INDEXER_START_BLOCK
// Optional body: { chain?: "STARKNET" | ... } — defaults to the active mirror chain
// ---------------------------------------------------------------------------
admin.post("/indexer/reset-cursor", async (c) => {
  const { resetCursor } = await import("../../../mirror/cursor.js");
  const { CHAIN } = await import("../../../mirror/index.js");
  const body = await c.req.json().catch(() => ({}));
  const chain = (body?.chain ?? CHAIN) as typeof CHAIN;
  // Optional `block` param lets you advance/rewind the cursor to any block.
  const toBlock = body?.block != null ? BigInt(body.block) : undefined;
  await resetCursor(chain, toBlock);
  const { env } = await import("../../../config/env.js");
  const lastBlock = toBlock != null ? toBlock.toString() : env.INDEXER_START_BLOCK;
  return c.json({ data: { chain, lastBlock } });
});

// ---------------------------------------------------------------------------
// GET /admin/collections — list collections with optional filters
// ---------------------------------------------------------------------------
admin.get("/collections", async (c) => {
  const page = parseInt(c.req.query("page") ?? "1");
  const limit = parseInt(c.req.query("limit") ?? "20");
  const service = c.req.query("service");
  const metadataStatus = c.req.query("metadataStatus");
  const isFeaturedParam = c.req.query("isFeatured");
  const search = c.req.query("search");

  const where: Record<string, unknown> = {};
  if (service) where.service = service;
  if (metadataStatus) where.metadataStatus = metadataStatus;
  if (isFeaturedParam !== undefined && isFeaturedParam !== "") where.isFeatured = isFeaturedParam === "true";
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
// GET /admin/collections/service-coverage — service-model distribution view.
// Originally the pre-drop migration gate; legacy `Collection.source` has now
// been dropped (Phase 2D.4 complete), so `missingService` is structurally 0
// and this endpoint stays as a permanent per-`service` distribution diagnostic.
// Response shape is preserved so the io admin panel keeps working unchanged.
// Static SQL, read-only.
// ---------------------------------------------------------------------------
admin.get("/collections/service-coverage", async (c) => {
  const byService = await prisma.$queryRawUnsafe<{ service: string | null; count: number }[]>(
    `SELECT service, COUNT(*)::int AS count FROM "Collection" GROUP BY service ORDER BY count DESC`
  );
  return c.json({
    data: {
      missingService: 0,
      safeToDropSourceColumn: true,
      byService,
      sampleMissing: [],
    },
  });
});

// ---------------------------------------------------------------------------
}
