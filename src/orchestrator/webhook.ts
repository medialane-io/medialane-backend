import { createHmac } from "crypto";
import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/error.js";

const log = createLogger("orchestrator:webhook");

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY = 2_000;
const MAX_DELIVERY_ATTEMPTS = 5;

export async function processDelivery(deliveryId: string): Promise<void> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });

  if (!delivery) {
    log.warn({ deliveryId }, "Delivery not found — skipping");
    return;
  }

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: { attemptCount: { increment: 1 } },
  });

  if (delivery.endpoint.status === "DISABLED") {
    log.info({ deliveryId, endpointId: delivery.endpoint.id }, "Endpoint disabled — skipping");
    return;
  }

  const body = JSON.stringify({
    id: deliveryId,
    event: delivery.eventType,
    data: delivery.payload,
  });

  const signature = createHmac("sha256", delivery.endpoint.secret)
    .update(body)
    .digest("hex");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let statusCode: number | undefined;
  let responseBody: string | undefined;

  try {
    const res = await fetch(delivery.endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-medialane-event": delivery.eventType,
        "x-medialane-signature": `sha256=${signature}`,
        "x-medialane-delivery": deliveryId,
      },
      body,
      signal: controller.signal,
    });

    statusCode = res.status;
    const rawBody = await res.text().catch(() => "");
    responseBody = rawBody.slice(0, MAX_RESPONSE_BODY);

    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        statusCode,
        responseBody,
        deliveredAt: res.ok ? new Date() : undefined,
      },
    });

    if (!res.ok) {
      throw new Error(`Endpoint returned ${statusCode}`);
    }

    log.debug({ deliveryId, statusCode }, "Webhook delivered");
  } catch (err: unknown) {
    const isTerminal = (delivery.attemptCount + 1) >= MAX_DELIVERY_ATTEMPTS;
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        statusCode: statusCode ?? null,
        responseBody: responseBody ?? toErrorMessage(err).slice(0, MAX_RESPONSE_BODY),
        ...(isTerminal ? { isTerminal: true } : {}),
      },
    }).catch((updateErr) =>
      log.warn({ updateErr, deliveryId }, "Failed to update delivery record after error")
    );

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const DELIVERY_POLL_MS = 10_000;

export async function startWebhookDeliveryLoop(): Promise<void> {
  log.info("Webhook delivery loop starting...");
  while (true) {
    try {
      await drainPendingDeliveries();
    } catch (err) {
      log.error({ err }, "Webhook delivery loop error");
    }
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_POLL_MS));
  }
}

async function drainPendingDeliveries(): Promise<void> {
  const pending = await prisma.webhookDelivery.findMany({
    where: {
      isTerminal: false,
      deliveredAt: null,
      attemptCount: { lt: 5 },
    },
    take: 20,
  });
  for (const delivery of pending) {
    await processDelivery(delivery.id);
  }
}
