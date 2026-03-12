import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import prisma from "../../db/client.js";
import { createLogger } from "../../utils/logger.js";
import { serializeOrder } from "../utils/serialize.js";

const log = createLogger("routes:events");
const events = new Hono();

const SSE_POLL_INTERVAL_MS = 2000;
const SSE_MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const SSE_KEEPALIVE_INTERVAL_MS = 15000;

events.get("/", async (c) => {
  const lastEventId = c.req.header("Last-Event-ID") ?? c.req.query("since");

  return streamSSE(c, async (stream) => {
    let since = lastEventId ? new Date(lastEventId) : new Date(Date.now() - 30_000);
    const startedAt = Date.now();
    let lastKeepalive = Date.now();

    while (!stream.closed) {
      if (Date.now() - startedAt > SSE_MAX_DURATION_MS) {
        // Signal client to reconnect
        await stream.writeSSE({ event: "reconnect", data: "" });
        break;
      }

      // Keepalive ping
      if (Date.now() - lastKeepalive > SSE_KEEPALIVE_INTERVAL_MS) {
        await stream.writeSSE({ event: "ping", data: "" });
        lastKeepalive = Date.now();
      }

      try {
        const [transfers, orders] = await Promise.all([
          prisma.transfer.findMany({
            where: { chain: "STARKNET", createdAt: { gt: since } },
            orderBy: { createdAt: "asc" },
            take: 50,
          }),
          prisma.order.findMany({
            where: {
              chain: "STARKNET",
              updatedAt: { gt: since },
              status: { in: ["ACTIVE", "FULFILLED", "CANCELLED"] },
            },
            orderBy: { updatedAt: "asc" },
            take: 50,
          }),
        ]);

        // Emit transfer events
        for (const t of transfers) {
          await stream.writeSSE({
            id: t.createdAt.toISOString(),
            event: "transfer",
            data: JSON.stringify({
              contractAddress: t.contractAddress,
              tokenId: t.tokenId,
              from: t.fromAddress,
              to: t.toAddress,
              txHash: t.txHash,
              blockNumber: t.blockNumber.toString(),
              timestamp: t.createdAt.toISOString(),
            }),
          });
          if (t.createdAt > since) since = t.createdAt;
        }

        // Emit order events
        for (const o of orders) {
          const eventType =
            o.status === "FULFILLED" ? "order.fulfilled" :
            o.status === "CANCELLED" ? "order.cancelled" :
            "order.created";
          await stream.writeSSE({
            id: o.updatedAt.toISOString(),
            event: eventType,
            data: JSON.stringify(serializeOrder(o)),
          });
          if (o.updatedAt > since) since = o.updatedAt;
        }
      } catch (err) {
        log.error({ err }, "SSE poll error");
      }

      await new Promise<void>((resolve) => setTimeout(resolve, SSE_POLL_INTERVAL_MS));
    }
  });
});

export { events };
