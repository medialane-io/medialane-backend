import { parseEventLogs, type Log } from "viem";
import {
  EvmMipCollectionABI,
  EvmMipRegistryABI,
  EvmVenueABI,
} from "@medialane/sdk/evm";

/**
 * Pure decode layer for the EVM ingestor — chain-native logs in, the
 * protocol's event vocabulary out (platform-federation spec §3.2). No RPC,
 * no DB: unit-testable with synthetic logs.
 */

export type EvmProtocolEvent =
  | {
      kind: "CollectionCreated";
      collection: `0x${string}`;
      creator: `0x${string}`;
      collectionId: bigint;
      name: string;
      symbol: string;
      baseUri: string;
      registry: `0x${string}`;
      blockNumber: bigint;
      txHash: `0x${string}`;
      logIndex: number;
    }
  | {
      kind: "Transfer";
      contract: `0x${string}`;
      from: `0x${string}`;
      to: `0x${string}`;
      tokenId: bigint;
      blockNumber: bigint;
      txHash: `0x${string}`;
      logIndex: number;
    }
  | {
      kind: "OrderCreated" | "OrderCancelled";
      venue: `0x${string}`;
      orderHash: `0x${string}`;
      offerer: `0x${string}`;
      blockNumber: bigint;
      txHash: `0x${string}`;
      logIndex: number;
    }
  | {
      kind: "OrderFulfilled";
      venue: `0x${string}`;
      orderHash: `0x${string}`;
      offerer: `0x${string}`;
      fulfiller: `0x${string}`;
      saleAmount: bigint;
      blockNumber: bigint;
      txHash: `0x${string}`;
      logIndex: number;
    };

export function decodeEvmLogs(logs: Log[]): EvmProtocolEvent[] {
  const events: EvmProtocolEvent[] = [];
  const abi = [...EvmVenueABI, ...EvmMipRegistryABI, ...EvmMipCollectionABI];
  for (const parsed of parseEventLogs({ abi, logs, strict: false })) {
    const base = {
      blockNumber: parsed.blockNumber ?? 0n,
      txHash: (parsed.transactionHash ?? "0x") as `0x${string}`,
      logIndex: parsed.logIndex ?? 0,
    };
    switch (parsed.eventName) {
      case "CollectionCreated":
        if (!parsed.args.collection || !parsed.args.creator || parsed.args.collectionId === undefined) break;
        events.push({
          kind: "CollectionCreated",
          collection: parsed.args.collection,
          creator: parsed.args.creator,
          collectionId: parsed.args.collectionId,
          name: parsed.args.name ?? "",
          symbol: parsed.args.symbol ?? "",
          baseUri: parsed.args.baseUri ?? "",
          registry: parsed.address,
          ...base,
        });
        break;
      case "Transfer":
        if (!parsed.args.from || !parsed.args.to || parsed.args.tokenId === undefined) break;
        events.push({
          kind: "Transfer",
          contract: parsed.address,
          from: parsed.args.from,
          to: parsed.args.to,
          tokenId: parsed.args.tokenId,
          ...base,
        });
        break;
      case "OrderCreated":
      case "OrderCancelled":
        if (!parsed.args.orderHash || !parsed.args.offerer) break;
        events.push({
          kind: parsed.eventName,
          venue: parsed.address,
          orderHash: parsed.args.orderHash,
          offerer: parsed.args.offerer,
          ...base,
        });
        break;
      case "OrderFulfilled":
        if (!parsed.args.orderHash || !parsed.args.offerer || !parsed.args.fulfiller) break;
        events.push({
          kind: "OrderFulfilled",
          venue: parsed.address,
          orderHash: parsed.args.orderHash,
          offerer: parsed.args.offerer,
          fulfiller: parsed.args.fulfiller,
          saleAmount: parsed.args.saleAmount ?? 0n,
          ...base,
        });
        break;
      default:
        break;
    }
  }
  return events;
}
