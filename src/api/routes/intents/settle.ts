// Background settlement + hydration helpers. Not Hono routes — invoked by
// the lifecycle handlers (`PATCH /:id/confirm` fires verifyAndSettle;
// `POST /:id/hydrate` calls the hydrate* helpers directly).
import { num } from "starknet";
import type { Hono } from "hono";
import prisma from "../../../db/client.js";
import { normalizeAddress, normalizeHash } from "../../../utils/starknet.js";
import {
  verifyMarketplaceTx,
  verifyTransactionSucceeded,
  checkOnChainOrderCancelled,
  fetchMarketplaceReceiptEvents,
  fetchReceiptEvents,
} from "../../../utils/txVerifier.js";
import { getServiceByMarketplaceAddress } from "../../../utils/collection.js";
import { handleOrderCreated, handleOrderCreated1155 } from "../../../mirror/handlers/orderCreated.js";
import { handleOrderFulfilled, parseRawOrderFulfilled1155 } from "../../../mirror/handlers/orderFulfilled.js";
import { dispatchTransfer } from "../../../mirror/handlers/transfer.js";
import { parseEvents } from "../../../mirror/parser.js";
import { getTokenByAddress } from "../../../config/constants.js";
import { runTransferFollowups } from "../../../orchestrator/transferFollowup.js";
import {
  log,
  MARKETPLACE_INTENT_TYPES,
  ORDER_CREATING_INTENT_TYPES,
  ORDER_CREATED_SELECTOR_HEX,
  ORDER_FULFILLED_SELECTOR_HEX,
  isNftTransferEvent,
} from "./_shared.js";

// Hono unused import suppression — kept here so future settle-side route
// additions can grow this file without re-importing.
export type _HonoMarker = Hono;

/** Background: verify tx receipt and settle intent to CONFIRMED or FAILED.
 *  For FULFILL_ORDER and CANCEL_ORDER intents, also syncs the order status in DB
 *  so the UI reflects the correct state before the indexer catches up (~6s delay).
 *  On cancel failure, checks on-chain status: if the order is already Cancelled
 *  on-chain (stale DB), syncs DB to CANCELLED so the listing disappears immediately. */
export async function verifyAndSettle(intentId: string, txHash: string): Promise<void> {
  const intent = await prisma.transactionIntent.findUnique({
    where: { id: intentId },
    select: { type: true, orderHash: true, requester: true },
  });
  const verifyResult = intent?.type && MARKETPLACE_INTENT_TYPES.has(intent.type)
    ? await verifyMarketplaceTx(txHash)
    : await verifyTransactionSucceeded(txHash);

  // Map intent types to the order status they should settle to.
  // Both branches do an atomic (intent + order) update so the UI reflects
  // the correct state before the indexer catches up.
  const ORDER_SETTLE_STATUS = {
    CANCEL_ORDER: "CANCELLED",
  } as const;

  if (verifyResult.status === "CONFIRMED") {
    let hydratedOrderHash: string | undefined;
    if (intent?.type && ORDER_CREATING_INTENT_TYPES.has(intent.type)) {
      try {
        const orderHashes = await hydrateCreatedOrdersFromTx(txHash);
        hydratedOrderHash = orderHashes[0];
      } catch (err) {
        log.error({ err, intentId, txHash, type: intent.type }, "Failed to hydrate created order from confirmed tx");
      }
    }
    if (intent?.type === "FULFILL_ORDER") {
      try {
        await hydrateFulfillmentFromTx(txHash);
      } catch (err) {
        log.error({ err, intentId, txHash, orderHash: intent.orderHash }, "Failed to hydrate fulfillment from confirmed tx");
      }
    }
    if (intent?.type === "MINT") {
      try {
        await hydrateTransfersFromTx(txHash);
      } catch (err) {
        log.error({ err, intentId, txHash }, "Failed to hydrate mint transfers from confirmed tx");
      }
    }

    const orderStatus = intent?.type ? ORDER_SETTLE_STATUS[intent.type as keyof typeof ORDER_SETTLE_STATUS] : undefined;
    if (orderStatus && intent?.orderHash) {
      await prisma.$transaction([
        prisma.transactionIntent.update({
          where: { id: intentId },
          data: { status: "CONFIRMED" },
        }),
        prisma.order.update({
          where: { chain_orderHash: { chain: "STARKNET", orderHash: intent.orderHash } },
          data: { status: orderStatus },
        }),
      ]);
    } else if (intent?.type === "CANCEL_ORDER" && intent.orderHash) {
      // Atomic: confirm intent + mark order CANCELLED immediately (don't wait for indexer)
      await prisma.$transaction([
        prisma.transactionIntent.update({
          where: { id: intentId },
          data: { status: "CONFIRMED" },
        }),
        prisma.order.update({
          where: { chain_orderHash: { chain: "STARKNET", orderHash: intent.orderHash } },
          data: { status: "CANCELLED" },
        }),
      ]);
    } else {
      await prisma.transactionIntent.update({
        where: { id: intentId },
        data: { status: "CONFIRMED", ...(hydratedOrderHash ? { orderHash: hydratedOrderHash } : {}) },
      });
    }
    log.info({ intentId, txHash, type: intent?.type }, "Intent CONFIRMED");
  } else {
    await prisma.transactionIntent.update({
      where: { id: intentId },
      data: { status: "FAILED" },
    });
    log.warn({ intentId, txHash, reason: verifyResult.failReason }, "Intent FAILED");

    // On cancel failure: the inner cancel_order call panicked — most likely because
    // the order was already cancelled on-chain (DB is stale). Check on-chain and sync.
    if (intent?.type === "CANCEL_ORDER" && intent.orderHash) {
      const order = await prisma.order.findUnique({
        where: { chain_orderHash: { chain: "STARKNET", orderHash: intent.orderHash } },
        select: { offerItemType: true },
      });
      const is1155 = order?.offerItemType === "ERC1155";
      const alreadyCancelled = await checkOnChainOrderCancelled(intent.orderHash, is1155);
      if (alreadyCancelled) {
        await prisma.order.updateMany({
          where: {
            chain: "STARKNET",
            orderHash: intent.orderHash,
            status: "ACTIVE",
          },
          data: { status: "CANCELLED" },
        });
        log.info({ intentId, orderHash: intent.orderHash }, "Stale order synced to CANCELLED after failed cancel tx");
      }
    }
  }
}

export async function hydrateCreatedOrdersFromTx(txHash: string): Promise<string[]> {
  const events = await fetchMarketplaceReceiptEvents(txHash);
  const createdEvents = events.filter((event) => num.toHex(event.keys[0] ?? "0x0") === ORDER_CREATED_SELECTOR_HEX);

  if (!createdEvents.length) {
    log.warn({ txHash }, "Confirmed marketplace tx had no OrderCreated events to hydrate");
    return [];
  }

  const hydratedOrderHashes: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (const event of createdEvents) {
      const orderHash = num.toHex(event.keys[1]);
      const venue = getServiceByMarketplaceAddress(event.from_address);
      if (venue?.standard === "ERC1155") {
        await handleOrderCreated1155(event, tx, "STARKNET");
        hydratedOrderHashes.push(orderHash);
        continue;
      }

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
      hydratedOrderHashes.push(orderHash);
    }
  }, { timeout: 60000 });

  log.info({ txHash, orderHashes: hydratedOrderHashes }, "Hydrated marketplace orders from confirmed tx");
  return hydratedOrderHashes;
}

export async function hydrateFulfillmentFromTx(txHash: string): Promise<void> {
  const rawEvents = await fetchReceiptEvents(txHash);
  const parsedEvents = parseEvents(rawEvents);
  const transferEvents = parsedEvents.filter(isNftTransferEvent);
  const rawFulfilledEvents = rawEvents.filter(
    (event) => num.toHex(event.keys[0] ?? "0x0") === ORDER_FULFILLED_SELECTOR_HEX
  );

  await prisma.$transaction(async (tx) => {
    for (const event of rawFulfilledEvents) {
      const venue = getServiceByMarketplaceAddress(event.from_address);
      if (venue?.standard === "ERC1155") {
        const parsed = parsedEvents.find(
          (parsedEvent) =>
            parsedEvent.type === "OrderFulfilled" &&
            parsedEvent.txHash === normalizeHash(event.transaction_hash) &&
            parsedEvent.orderHash === num.toHex(event.keys[1])
        );
        const logIndex = parsed?.type === "OrderFulfilled" ? parsed.logIndex : 0;
        const parsedFulfilled = parseRawOrderFulfilled1155(event, logIndex);
        await handleOrderFulfilled(parsedFulfilled, tx, "STARKNET");
      }
    }

    for (const event of parsedEvents) {
      if (event.type === "OrderFulfilled") {
        const is1155 = rawFulfilledEvents.some(
          (raw) =>
            getServiceByMarketplaceAddress(raw.from_address)?.standard === "ERC1155" &&
            normalizeAddress(raw.keys[1]) === normalizeAddress(event.orderHash)
        );
        if (!is1155) {
          await handleOrderFulfilled(event, tx, "STARKNET");
        }
        continue;
      }

      if (
        (event.type === "Transfer" || event.type === "TransferSingle" || event.type === "TransferBatch") &&
        !getTokenByAddress(event.contractAddress)
      ) {
        await dispatchTransfer(event, tx, "STARKNET");
      }
    }
  }, { timeout: 60000 });

  const followup = await runTransferFollowups(transferEvents, "STARKNET");

  log.info({ txHash, followup }, "Hydrated fulfillment and transfer balances from confirmed tx");
}

export async function hydrateTransfersFromTx(txHash: string): Promise<void> {
  const rawEvents = await fetchReceiptEvents(txHash);
  const parsedEvents = parseEvents(rawEvents);
  const transferEvents = parsedEvents.filter(isNftTransferEvent);

  await prisma.$transaction(async (tx) => {
    for (const event of transferEvents) {
      await dispatchTransfer(event, tx, "STARKNET");
    }
  }, { timeout: 60000 });

  const followup = await runTransferFollowups(transferEvents, "STARKNET");

  log.info({ txHash, followup }, "Hydrated NFT transfers from confirmed tx");
}
