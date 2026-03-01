import { createHmac } from "crypto";
import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/error.js";

const log = createLogger("orchestrator:webhook");

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY = 2_000;

export async function handleWebhookDeliver(payload: { deliveryId: string }): Promise<void> {
  const { deliveryId } = payload;

  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });

  if (!delivery) {
    log.warn({ deliveryId }, "Delivery not found — skipping");
    return; // don't retry
  }

  if (delivery.endpoint.status === "DISABLED") {
    log.info({ deliveryId, endpointId: delivery.endpoint.id }, "Endpoint disabled — skipping");
    return; // don't retry
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
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        statusCode: statusCode ?? null,
        responseBody: responseBody ?? toErrorMessage(err).slice(0, MAX_RESPONSE_BODY),
      },
    }).catch((updateErr) =>
      log.warn({ updateErr, deliveryId }, "Failed to update delivery record after error")
    );

    throw err; // re-throw so failJob triggers retry
  } finally {
    clearTimeout(timer);
  }
}
