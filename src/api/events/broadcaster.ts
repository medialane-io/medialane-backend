import type { Chain } from "@prisma/client";
import prisma from "../../db/client.js";
import { serializeOrder, type SerializableOrder } from "../utils/serialize.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("events:broadcaster");

export interface SseEvent {
  id: string;
  event: string;
  data: string;

  chain: Chain;
}

export interface Subscriber {
  chain: Chain | "all";
  push: (evt: SseEvent) => void;
}

export type FetchNewEvents = (since: Date) => Promise<{ events: SseEvent[]; next: Date }>;

export function buildTransferEvent(t: {
  chain: Chain; contractAddress: string; tokenId: string; fromAddress: string;
  toAddress: string; txHash: string; blockNumber: bigint; createdAt: Date;
}): SseEvent {
  return {
    id: t.createdAt.toISOString(),
    event: "transfer",
    chain: t.chain,
    data: JSON.stringify({
      contractAddress: t.contractAddress,
      tokenId: t.tokenId,
      from: t.fromAddress,
      to: t.toAddress,
      txHash: t.txHash,
      blockNumber: t.blockNumber.toString(),
      timestamp: t.createdAt.toISOString(),
    }),
  };
}

export function buildOrderEvent(o: SerializableOrder): SseEvent {
  const eventType =
    o.status === "FULFILLED" ? "order.fulfilled" :
    o.status === "CANCELLED" ? "order.cancelled" :
    "order.created";
  return {
    id: o.updatedAt.toISOString(),
    event: eventType,
    chain: o.chain,
    data: JSON.stringify(serializeOrder(o)),
  };
}

const defaultFetch: FetchNewEvents = async (since) => {
  const [transfers, orders] = await Promise.all([
    prisma.transfer.findMany({
      where: { createdAt: { gt: since } },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
    prisma.order.findMany({
      where: { updatedAt: { gt: since }, status: { in: ["ACTIVE", "FULFILLED", "CANCELLED"] } },
      orderBy: { updatedAt: "asc" },
      take: 50,
    }),
  ]);
  let next = since;
  for (const t of transfers) if (t.createdAt > next) next = t.createdAt;
  for (const o of orders) if (o.updatedAt > next) next = o.updatedAt;
  return {
    events: [...transfers.map(buildTransferEvent), ...orders.map(buildOrderEvent)],
    next,
  };
};

export class EventsBroadcaster {
  private readonly subs = new Set<Subscriber>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private since = new Date();
  private ticking = false;

  constructor(
    private readonly fetchNewEvents: FetchNewEvents = defaultFetch,
    private readonly intervalMs = 2000,
  ) {}

  get subscriberCount(): number {
    return this.subs.size;
  }

  subscribe(sub: Subscriber): () => void {
    this.subs.add(sub);
    if (this.subs.size === 1) {
      this.since = new Date();
      this.schedule();
    }
    return () => {
      this.subs.delete(sub);
      if (this.subs.size === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { events, next } = await this.fetchNewEvents(this.since);
      this.since = next;
      for (const evt of events) {
        for (const sub of this.subs) {
          if (sub.chain === "all" || sub.chain === evt.chain) sub.push(evt);
        }
      }
    } catch (err) {
      log.error({ err }, "broadcast tick error");
    } finally {
      this.ticking = false;
      if (this.subs.size > 0) this.schedule();
    }
  }
}

export const eventsBroadcaster = new EventsBroadcaster();
