import { randomUUID } from "crypto";
import type { WebhookEventType } from "@prisma/client";
import type { ParsedEvent } from "../types/marketplace.js";
import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("webhookFanout");

export async function fanoutWebhooks(
  eventType: WebhookEventType,
  payload: Record<string, unknown>
): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: {
      status: "ACTIVE",
      events: { has: eventType },
      account: { status: "ACTIVE" },
    },
    select: { id: true },
  });

  if (endpoints.length === 0) return;

  log.debug({ eventType, count: endpoints.length }, "Fanning out webhooks");

  for (const endpoint of endpoints) {
    try {
      const deliveryId = randomUUID();
      await prisma.webhookDelivery.create({
        data: {
          id: deliveryId,
          endpointId: endpoint.id,
          eventType,
          payload: payload as any,
        },
      });
    } catch (err) {
      log.error({ err, endpointId: endpoint.id, eventType }, "Failed to fanout webhook");
    }
  }
}

export function buildWebhookPayload(event: ParsedEvent): {
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
} {
  const base = {
    blockNumber: event.blockNumber.toString(),
    txHash: event.txHash,
    logIndex: event.logIndex,
  };

  switch (event.type) {
    case "OrderCreated":
      return {
        eventType: "ORDER_CREATED",
        payload: { ...base, orderHash: event.orderHash, offerer: event.offerer },
      };
    case "OrderFulfilled":
      return {
        eventType: "ORDER_FULFILLED",
        payload: {
          ...base,
          orderHash: event.orderHash,
          offerer: event.offerer,
          fulfiller: event.fulfiller,
        },
      };
    case "OrderCancelled":
      return {
        eventType: "ORDER_CANCELLED",
        payload: { ...base, orderHash: event.orderHash, offerer: event.offerer },
      };
    case "Transfer":
      return {
        eventType: "TRANSFER",
        payload: {
          ...base,
          contractAddress: event.contractAddress,
          from: event.from,
          to: event.to,
          tokenId: event.tokenId,
        },
      };
    case "TransferSingle":
      return {
        eventType: "TRANSFER",
        payload: {
          ...base,
          contractAddress: event.contractAddress,
          operator: event.operator,
          from: event.from,
          to: event.to,
          tokenId: event.tokenId,
          amount: event.amount,
        },
      };
    case "TransferBatch":
      return {
        eventType: "TRANSFER",
        payload: {
          ...base,
          contractAddress: event.contractAddress,
          operator: event.operator,
          from: event.from,
          to: event.to,
          transfers: event.transfers,
        },
      };
    case "CollectionCreated":
      return {
        eventType: "TRANSFER",
        payload: { ...base, collectionId: event.collectionId, owner: event.owner },
      };
    case "CounterIncremented":
      // Bulk-cancel: the offerer's open orders are invalidated en masse. No single
      // orderHash; reuse ORDER_CANCELLED with offerer + newCounter (no new enum value).
      return {
        eventType: "ORDER_CANCELLED",
        payload: { ...base, offerer: event.offerer, newCounter: event.newCounter, bulk: true },
      };
    default: {
      // Exhaustiveness guard: a new ParsedEvent variant must add a case here.
      // Never return undefined — the caller destructures the result unguarded.
      const _exhaustive: never = event;
      log.warn({ event: _exhaustive }, "buildWebhookPayload: unhandled event type");
      return { eventType: "TRANSFER", payload: base };
    }
  }
}
