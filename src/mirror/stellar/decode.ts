/**
 * Pure decode layer for the Stellar ingestor — Soroban `getEvents` responses
 * with `xdrFormat: "json"` (topics/value as JSON-shaped ScVals). Topic
 * conventions from the audited contracts: venue publishes
 * (symbol, offerer[, fulfiller]) topics; the registry publishes
 * ("created", collection_id). No RPC, no DB.
 */

type ScVal = Record<string, unknown>;

export interface StellarRawEvent {
  contractId: string;
  ledger: number;
  txHash: string;
  topic: ScVal[];
  value: ScVal;
}

export type StellarProtocolEvent =
  | { kind: "CollectionCreated"; registry: string; collectionId: bigint; collection: string; creator: string; name: string; ledger: number; txHash: string }
  | { kind: "OrderCreated" | "OrderCancelled"; venue: string; offerer: string; salt: bigint; ledger: number; txHash: string }
  | { kind: "OrderFulfilled"; venue: string; offerer: string; fulfiller: string; salt: bigint; saleAmount: bigint; ledger: number; txHash: string };

const sym = (v: ScVal | undefined): string | undefined => (v?.symbol as string) ?? undefined;
const addr = (v: ScVal | undefined): string | undefined => (v?.address as string) ?? undefined;
const u64 = (v: ScVal | undefined): bigint | undefined =>
  v && "u64" in v ? BigInt(v.u64 as string | number) : undefined;
const i128 = (v: ScVal | undefined): bigint | undefined =>
  v && "i128" in v ? BigInt((v.i128 as { lo?: string | number })?.lo ?? (v.i128 as string | number)) : undefined;

export function decodeStellarEvents(
  events: StellarRawEvent[],
  registries: Set<string>,
): StellarProtocolEvent[] {
  const out: StellarProtocolEvent[] = [];
  for (const e of events) {
    const kind = sym(e.topic[0]);
    const base = { ledger: e.ledger, txHash: e.txHash };
    if (kind === "created" && registries.has(e.contractId)) {
      const collectionId = u64(e.topic[1]);
      const tuple = (e.value?.vec as ScVal[] | undefined) ?? [];
      const collection = addr(tuple[0]);
      const creator = addr(tuple[1]);
      const name = (tuple[2]?.string as string) ?? "";
      if (collectionId !== undefined && collection && creator) {
        out.push({ kind: "CollectionCreated", registry: e.contractId, collectionId, collection, creator, name, ...base });
      }
      continue;
    }
    if (kind === "created" || kind === "cancelled") {
      const offerer = addr(e.topic[1]);
      const salt = u64(e.value);
      if (offerer && salt !== undefined) {
        out.push({ kind: kind === "created" ? "OrderCreated" : "OrderCancelled", venue: e.contractId, offerer, salt, ...base });
      }
      continue;
    }
    if (kind === "filled") {
      const offerer = addr(e.topic[1]);
      const fulfiller = addr(e.topic[2]);
      const tuple = (e.value?.vec as ScVal[] | undefined) ?? [];
      const salt = u64(tuple[0]);
      const saleAmount = i128(tuple[1]) ?? 0n;
      if (offerer && fulfiller && salt !== undefined) {
        out.push({ kind: "OrderFulfilled", venue: e.contractId, offerer, fulfiller, salt, saleAmount, ...base });
      }
    }
  }
  return out;
}
