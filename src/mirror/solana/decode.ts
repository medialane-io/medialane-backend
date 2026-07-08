import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

/**
 * Pure decode layer for the Solana ingestor — Anchor `emit!` events arrive in
 * transaction logs as `Program data: <base64(discriminator ++ borsh)>`.
 * Layouts copied from the audited programs. No RPC, no DB.
 */

export type SolanaProtocolEvent =
  | { kind: "CollectionCreated"; collectionId: bigint; coreCollection: string; creator: string; name: string; uri: string }
  | { kind: "AssetMinted"; coreCollection: string; asset: string; owner: string; uri: string }
  | { kind: "OrderCreated" | "OrderCancelled"; order: string; offerer: string }
  | { kind: "OrderFulfilled"; order: string; offerer: string; fulfiller: string; saleAmount: bigint; royaltyReceiver: string; royaltyAmount: bigint }
  | { kind: "CounterIncremented"; offerer: string; newCounter: bigint };

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  pubkey(): string {
    const v = base58.encode(this.bytes.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }
  u64(): bigint {
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8).getBigUint64(0, true);
    this.offset += 8;
    return v;
  }
  string(): string {
    const len = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getUint32(0, true);
    this.offset += 4;
    const v = new TextDecoder().decode(this.bytes.subarray(this.offset, this.offset + len));
    this.offset += len;
    return v;
  }
}

function disc(name: string): string {
  return Buffer.from(sha256(new TextEncoder().encode(`event:${name}`)).slice(0, 8)).toString("hex");
}

const DISCRIMINATORS: Record<string, SolanaProtocolEvent["kind"]> = {
  [disc("CollectionCreated")]: "CollectionCreated",
  [disc("AssetMinted")]: "AssetMinted",
  [disc("OrderCreated")]: "OrderCreated",
  [disc("OrderCancelled")]: "OrderCancelled",
  [disc("OrderFulfilled")]: "OrderFulfilled",
  [disc("CounterIncremented")]: "CounterIncremented",
};

export function decodeSolanaLogs(logs: string[]): SolanaProtocolEvent[] {
  const events: SolanaProtocolEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(line.slice("Program data: ".length)), (c) => c.charCodeAt(0));
    } catch {
      continue;
    }
    if (bytes.length < 8) continue;
    const kind = DISCRIMINATORS[Buffer.from(bytes.subarray(0, 8)).toString("hex")];
    if (!kind) continue;
    const r = new Reader(bytes.subarray(8));
    switch (kind) {
      case "CollectionCreated":
        events.push({ kind, collectionId: r.u64(), coreCollection: r.pubkey(), creator: r.pubkey(), name: r.string(), uri: r.string() });
        break;
      case "AssetMinted":
        events.push({ kind, coreCollection: r.pubkey(), asset: r.pubkey(), owner: r.pubkey(), uri: r.string() });
        break;
      case "OrderCreated":
      case "OrderCancelled":
        events.push({ kind, order: r.pubkey(), offerer: r.pubkey() });
        break;
      case "OrderFulfilled":
        events.push({ kind, order: r.pubkey(), offerer: r.pubkey(), fulfiller: r.pubkey(), saleAmount: r.u64(), royaltyReceiver: r.pubkey(), royaltyAmount: r.u64() });
        break;
      case "CounterIncremented":
        events.push({ kind, offerer: r.pubkey(), newCounter: r.u64() });
        break;
    }
  }
  return events;
}
