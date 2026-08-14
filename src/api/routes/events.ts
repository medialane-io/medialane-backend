import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import prisma from "../../db/client.js";
import { chainWhere, parseChainFilter } from "../utils/chainFilter.js";
import { createLogger } from "../../utils/logger.js";
import {
  eventsBroadcaster,
  buildTransferEvent,
  buildOrderEvent,
  type SseEvent,
} from "../events/broadcaster.js";

const log = createLogger("routes:events");
const events = new Hono();

const SSE_MAX_DURATION_MS = 10 * 60 * 1000;
const SSE_KEEPALIVE_INTERVAL_MS = 15000;

events.get("/", async (c) => {
  const chainFilter = parseChainFilter(c.req.query("chain"));
  if (!chainFilter) return c.json({ error: "Invalid chain" }, 400);
  const chainClause = chainWhere(chainFilter);
  const subChain = chainFilter === "all" ? ("all" as const) : chainFilter.chain;
  const lastEventId = c.req.header("Last-Event-ID") ?? c.req.query("since");

  return streamSSE(c, async (stream) => {
    const startedAt = Date.now();
    const queue: SseEvent[] = [];
    let notify: (() => void) | null = null;

    const unsubscribe = eventsBroadcaster.subscribe({
      chain: subChain,
      push: (evt) => {
        queue.push(evt);
        notify?.();
      },
    });

    try {

      const since = lastEventId ? new Date(lastEventId) : new Date(Date.now() - 30_000);
      const [transfers, orders] = await Promise.all([
        prisma.transfer.findMany({
          where: { ...chainClause, createdAt: { gt: since } },
          orderBy: { createdAt: "asc" },
          take: 50,
        }),
        prisma.order.findMany({
          where: {
            ...chainClause,
            updatedAt: { gt: since },
            status: { in: ["ACTIVE", "FULFILLED", "CANCELLED"] },
          },
          orderBy: { updatedAt: "asc" },
          take: 50,
        }),
      ]);
      for (const t of transfers) await stream.writeSSE(buildTransferEvent(t));
      for (const o of orders) await stream.writeSSE(buildOrderEvent(o));

      while (!stream.closed) {
        if (Date.now() - startedAt > SSE_MAX_DURATION_MS) {
          await stream.writeSSE({ event: "reconnect", data: "" });
          break;
        }

        if (queue.length === 0) {

          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, SSE_KEEPALIVE_INTERVAL_MS);
            notify = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          notify = null;
        }

        if (queue.length === 0) {
          await stream.writeSSE({ event: "ping", data: "" });
          continue;
        }

        while (queue.length > 0) {
          const evt = queue.shift()!;
          await stream.writeSSE({ id: evt.id, event: evt.event, data: evt.data });
        }
      }
    } catch (err) {
      log.error({ err }, "SSE stream error");
    } finally {
      unsubscribe();
    }
  });
});

export { events };
