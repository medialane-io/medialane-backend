import type { Chain } from "@prisma/client";
import { getCoordinates, type StellarCoordinates } from "@medialane/sdk";
import { prisma } from "../../db/client.js";
import { createLogger } from "../../utils/logger.js";
import type { ChainIngestor } from "../ingestor.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { env } from "../../config/env.js";
import { decodeStellarEvents, type StellarProtocolEvent, type StellarRawEvent } from "./decode.js";

const log = createLogger("stellar-ingestor");

const POLL_MS = Number(process.env.STELLAR_POLL_INTERVAL_MS ?? 20_000);
const LEDGER_BATCH = 5_000;

/**
 * Stellar chain ingestor — Soroban `getEvents` (xdrFormat "json") over our
 * venue + registry contract ids, ledger-ranged with the chain's
 * IndexerCursor. Deploy-gated; foreign contracts never bulk-indexed.
 */
export function makeStellarIngestor(): ChainIngestor {
  return {
    chain: "STELLAR" as Chain,
    start() {
      const coords = maybeCoords();
      const contracts = [coords?.marketplace, coords?.mipRegistry].filter(Boolean) as string[];
      if (contracts.length === 0) {
        log.info("no coordinates configured — ingestor dormant until deploy");
        return;
      }
      const rpcUrl = env.STELLAR_RPC_URL ?? coords!.rpcUrl;
      const registries = new Set([coords!.mipRegistry].filter(Boolean) as string[]);
      const startLedger = coords!.startLedger ?? 0;
      const tick = async () => {
        try {
          await pollOnce(rpcUrl, contracts, registries, startLedger);
        } catch (err) {
          log.error({ err }, "stellar ingestor tick failed");
        } finally {
          setTimeout(tick, POLL_MS);
        }
      };
      void tick();
    },
  };
}

export async function pollOnce(
  rpcUrl: string,
  contracts: string[],
  registries: Set<string>,
  startLedger: number,
): Promise<void> {
  const cursor = await prisma.indexerCursor.findUnique({ where: { chain: "STELLAR" } });
  const from = cursor ? Number(cursor.lastBlock) + 1 : startLedger;

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getEvents",
      params: {
        startLedger: from,
        filters: [{ type: "contract", contractIds: contracts }],
        pagination: { limit: 200 },
        xdrFormat: "json",
      },
    }),
  });
  const json = (await res.json()) as {
    result?: { events?: RawRpcEvent[]; latestLedger?: number };
    error?: { message?: string };
  };
  if (json.error) throw new Error(`stellar getEvents: ${json.error.message}`);
  const rawEvents = (json.result?.events ?? []).map(
    (e): StellarRawEvent => ({
      contractId: e.contractId,
      ledger: e.ledger,
      txHash: e.txHash,
      topic: (e.topicJson ?? []) as StellarRawEvent["topic"],
      value: (e.valueJson ?? {}) as StellarRawEvent["value"],
    }),
  );
  const events = decodeStellarEvents(rawEvents, registries);
  await applyEvents(events);

  const latest = json.result?.latestLedger ?? from;
  await prisma.indexerCursor.upsert({
    where: { chain: "STELLAR" },
    create: { chain: "STELLAR", lastBlock: BigInt(latest) },
    update: { lastBlock: BigInt(latest) },
  });
  if (events.length > 0) log.info({ from, latest, events: events.length }, "stellar events applied");
}

interface RawRpcEvent {
  contractId: string;
  ledger: number;
  txHash: string;
  topicJson?: unknown[];
  valueJson?: unknown;
}

export async function applyEvents(events: StellarProtocolEvent[]): Promise<void> {
  const chain = "STELLAR" as Chain;
  for (const event of events) {
    switch (event.kind) {
      case "CollectionCreated":
        await upsertCollectionFromFactory(prisma, {
          chain,
          contractAddress: event.collection,
          service: "mip-erc721",
          standard: "ERC721",
          name: event.name,
          owner: event.creator,
          startBlock: BigInt(event.ledger),
          collectionId: event.collectionId.toString(),
        });
        break;
      case "OrderCreated":
        await prisma.order.upsert({
          where: { chain_orderHash: { chain, orderHash: orderRef(event) } },
          create: {
            chain,
            orderHash: orderRef(event),
            offerer: event.offerer,
            status: "ACTIVE",
            createdBlockNumber: BigInt(event.ledger),
            txHash: event.txHash,
          } as never,
          update: {},
        });
        break;
      case "OrderFulfilled":
        await prisma.order.updateMany({
          where: { chain, orderHash: orderRef(event) },
          data: { status: "FULFILLED", fulfiller: event.fulfiller },
        });
        break;
      case "OrderCancelled":
        await prisma.order.updateMany({
          where: { chain, orderHash: orderRef(event) },
          data: { status: "CANCELLED" },
        });
        break;
    }
  }
}

/** Canonical Stellar order id (spec §3.2b): digest of (contract, offerer,
 *  salt) — matches the SDK's stellarOrderRef. */
function orderRef(e: { venue: string; offerer: string; salt: bigint }): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return (
    "0x" + createHash("sha256").update(`${e.venue}:${e.offerer}:${e.salt.toString()}`).digest("hex")
  );
}

function maybeCoords(): StellarCoordinates | undefined {
  try {
    return getCoordinates("STELLAR") as StellarCoordinates;
  } catch {
    return undefined;
  }
}
