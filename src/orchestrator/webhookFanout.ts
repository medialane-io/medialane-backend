import { randomUUID } from "crypto";
import type { WebhookEventType } from "@prisma/client";
import type { ParsedEvent } from "../types/marketplace.js";
import prisma from "../db/client.js";
import { enqueueJob } from "./queue.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("webhookFanout");

/**
 * For a given event type, find all active webhook endpoints subscribed to it
 * (belonging to ACTIVE tenants), create a WebhookDelivery record, and enqueue
 * a WEBHOOK_DELIVER job for each.
 */
export async function fanoutWebhooks(
  eventType: WebhookEventType,
  payload: Record<string, unknown>
): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: {
      status: "ACTIVE",
      events: { has: eventType },
      tenant: { status: "ACTIVE" },
    },
    select: { id: true },
  });

  if (endpoints.length === 0) return;

  log.debug({ eventType, count: endpoints.length }, "Fanning out webhooks");

  for (const endpoint of endpoints) {
    try {
      // Pre-generate the delivery ID so we can pass it to the job and create
      // the delivery record in 2 DB calls instead of 3 (no update needed).
      const deliveryId = randomUUID();

      const jobId = await enqueueJob(
        "WEBHOOK_DELIVER",
        { deliveryId },
        { maxAttempts: 5 }
      );

      await prisma.webhookDelivery.create({
        data: {
          id: deliveryId,
          endpointId: endpoint.id,
          eventType,
          payload: payload as any,
          jobId,
        },
      });
    } catch (err) {
      log.error({ err, endpointId: endpoint.id, eventType }, "Failed to fanout webhook");
    }
  }
}

/** Map a ParsedEvent to its WebhookEventType + serialisable payload. */
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
  }
}
