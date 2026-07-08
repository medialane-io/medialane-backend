import { callRpc } from "../utils/starknet.js";
import type { RawStarknetEvent } from "../types/starknet.js";

/**
 * Fetch events from one contract for a block range, following continuation-
 * token pagination. The single RPC fetch primitive behind every event source
 * (see `sources.ts` — which contract, which selectors, and how often are all
 * declared there, never here).
 */
export async function pollContractEvents(params: {
  address: string;
  fromBlock: number;
  toBlock: number;
  keys: string[][];
  chunkSize?: number;
  maxPages?: number;
}): Promise<RawStarknetEvent[]> {
  const allEvents: RawStarknetEvent[] = [];
  let continuationToken: string | undefined = undefined;
  let page = 0;
  do {
    const response = await callRpc((provider) => provider.getEvents({
      address: params.address,
      from_block: { block_number: params.fromBlock },
      to_block: { block_number: params.toBlock },
      keys: params.keys,
      chunk_size: params.chunkSize ?? 1000,
      continuation_token: continuationToken,
    }));

    if (response.events?.length) {
      allEvents.push(...(response.events as unknown as RawStarknetEvent[]));
    }

    continuationToken = response.continuation_token;
    page++;
  } while (continuationToken && (params.maxPages === undefined || page < params.maxPages));

  return allEvents;
}

export async function getLatestBlock(): Promise<number> {
  const block = await callRpc((provider) => provider.getBlockWithTxHashes("latest"));
  return (block as any).block_number as number;
}
