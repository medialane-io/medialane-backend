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
import { normalizeAddress, normalizeHash } from "../../../utils/starknet.js";
import { handleOrderCreated, handleOrderCreated1155 } from "../../../mirror/handlers/orderCreated.js";
import { pollCollectionCreatedEvents, pollTransferEvents, getLatestBlock } from "../../../mirror/poller.js";
import { dispatchTransfer } from "../../../mirror/handlers/transfer.js";
import { parseEvents } from "../../../mirror/parser.js";
import { fetchMarketplaceReceiptEvents, fetchReceiptEvents } from "../../../utils/txVerifier.js";
import { MARKETPLACE_1155_CONTRACT, ORDER_CREATED_SELECTOR, ZERO_ADDRESS, getTokenByAddress } from "../../../config/constants.js";
import { num } from "starknet";
import type { ParsedTransfer, ParsedTransferBatch, ParsedTransferSingle } from "../../../types/marketplace.js";

import { InMemoryRateLimitStore } from "../../middleware/rateLimit.js";
import { toErrorMessage } from "../../../utils/error.js";
import { isNftTransferEvent, ORDER_CREATED_SELECTOR_HEX } from "./_shared.js";

const log = createLogger("routes:admin");

export function registerMarketplaceOpsRoutes(admin: Hono) {
// POST /admin/orders/:orderHash/resync — re-fetch order details from chain and fix price
// Routes to the correct handler based on token standard (ERC-721 vs ERC-1155).
// ---------------------------------------------------------------------------
admin.post("/orders/:orderHash/resync", async (c) => {
  const orderHash = c.req.param("orderHash");
  const order = await prisma.order.findFirst({ where: { orderHash } });
  if (!order) return c.json({ error: "Order not found" }, 404);

  await prisma.$transaction(async (tx) => {
    if (order.offerItemType === "ERC1155") {
      // Reconstruct a minimal RawStarknetEvent from stored order data
      // so we can re-run the 1155 handler without an RPC call.
      await handleOrderCreated1155(
        {
          keys: ["0x0", order.orderHash, order.offerer],
          data: [
            order.nftContract ?? "",
            order.nftTokenId ?? "0",
            order.offerStartAmount ?? "0",
            order.priceRaw ?? "0",
            order.considerationToken ?? "",
          ],
          block_number: Number(order.createdBlockNumber),
          transaction_hash: order.createdTxHash ?? "",
          from_address: "",
          block_hash: "",
        },
        tx,
        order.chain
      );
    } else {
      await handleOrderCreated(
        { type: "OrderCreated", orderHash, offerer: order.offerer, blockNumber: order.createdBlockNumber, txHash: order.createdTxHash ?? "", logIndex: 0 },
        tx,
        order.chain
      );
    }
  });

  const updated = await prisma.order.findFirst({ where: { orderHash } });
  return c.json({ priceRaw: updated?.priceRaw, priceFormatted: updated?.priceFormatted, currencySymbol: updated?.currencySymbol });
});

// ---------------------------------------------------------------------------
// POST /admin/marketplace/tx/:txHash/hydrate — hydrate OrderCreated rows from a tx receipt
// ---------------------------------------------------------------------------
admin.post("/marketplace/tx/:txHash/hydrate", async (c) => {
  const txHash = c.req.param("txHash");
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(txHash)) {
    return c.json({ error: "Invalid transaction hash" }, 400);
  }

  const events = await fetchMarketplaceReceiptEvents(txHash);
  const createdEvents = events.filter((event) => num.toHex(event.keys[0] ?? "0x0") === ORDER_CREATED_SELECTOR_HEX);
  if (!createdEvents.length) {
    return c.json({ error: "No OrderCreated events found for marketplace transaction" }, 404);
  }

  const hydrated: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (const event of createdEvents) {
      const orderHash = num.toHex(event.keys[1]);
      const is1155 = event.from_address === normalizeAddress(MARKETPLACE_1155_CONTRACT);
      if (is1155) {
        await handleOrderCreated1155(event, tx, "STARKNET");
      } else {
        await handleOrderCreated(
          {
            type: "OrderCreated",
            orderHash,
            offerer: normalizeAddress(event.keys[2]),
            blockNumber: BigInt(event.block_number),
            txHash: event.transaction_hash,
            logIndex: 0,
          },
          tx,
          "STARKNET"
        );
      }
      hydrated.push(orderHash);
    }
  }, { timeout: 60000 });

  log.info({ txHash, orderHashes: hydrated }, "Marketplace tx hydrated via admin");
  return c.json({ txHash, orderHashes: hydrated });
});

// ---------------------------------------------------------------------------
// POST /admin/transfers/tx/:txHash/hydrate — hydrate NFT Transfer rows from a tx receipt
// ---------------------------------------------------------------------------
admin.post("/transfers/tx/:txHash/hydrate", async (c) => {
  const txHash = c.req.param("txHash");
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(txHash)) {
    return c.json({ error: "Invalid transaction hash" }, 400);
  }

  const rawEvents = await fetchReceiptEvents(txHash);
  const transferEvents = parseEvents(rawEvents).filter(isNftTransferEvent);

  if (!transferEvents.length) {
    return c.json({ error: "No NFT transfer events found for transaction" }, 404);
  }

  await prisma.$transaction(async (tx) => {
    for (const event of transferEvents) {
      await dispatchTransfer(event, tx, "STARKNET");
    }
  }, { timeout: 60000 });
  const followup = await runTransferFollowups(transferEvents, "STARKNET");

  const hydrated = transferEvents.map((event) => {
    if (event.type === "TransferBatch") {
      return {
        type: event.type,
        contractAddress: event.contractAddress,
        transfers: event.transfers.map((transfer) => ({
          tokenId: transfer.tokenId,
          amount: transfer.amount,
        })),
      };
    }

    return {
      type: event.type,
      contractAddress: event.contractAddress,
      tokenId: event.tokenId,
      amount: event.type === "TransferSingle" ? event.amount : "1",
      from: event.from,
      to: event.to,
    };
  });

  log.info({ txHash, transferCount: transferEvents.length, followup }, "NFT transfers hydrated via admin tx receipt");
  return c.json({ txHash, hydrated, followup });
});

// ---------------------------------------------------------------------------
// POST /admin/orders/:orderHash/cancel — force-cancel an order that the indexer missed
// ---------------------------------------------------------------------------
admin.post("/orders/:orderHash/cancel", async (c) => {
  const orderHash = c.req.param("orderHash");
  const order = await prisma.order.findFirst({ where: { orderHash } });
  if (!order) return c.json({ error: "Order not found" }, 404);

  if (order.status === "CANCELLED") {
    return c.json({ status: "CANCELLED", note: "Already cancelled" });
  }

  await prisma.order.update({
    where: { chain_orderHash: { chain: order.chain, orderHash } },
    data: { status: "CANCELLED" },
  });

  return c.json({ status: "CANCELLED", orderHash });
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
}
