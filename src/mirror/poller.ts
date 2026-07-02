import { callRpc } from "../utils/starknet.js";
import {
  STARKNET_MARKETPLACE_721_CONTRACT,
  STARKNET_MARKETPLACE_1155_CONTRACT,
  STARKNET_COLLECTION_721_CONTRACT,
  ORDER_CREATED_SELECTOR,
  ORDER_FULFILLED_SELECTOR,
  ORDER_CANCELLED_SELECTOR,
  COUNTER_INCREMENTED_SELECTOR,
  TRANSFER_SELECTOR,
  TRANSFER_SINGLE_SELECTOR,
  TRANSFER_BATCH_SELECTOR,
  COLLECTION_CREATED_SELECTOR,
  STARKNET_NFTCOMMENTS_CONTRACT,
  COMMENT_ADDED_SELECTOR,
  STARKNET_POP_FACTORY_CONTRACT,
  POP_ALLOWLIST_UPDATED_SELECTOR,
  STARKNET_DROP_FACTORY_CONTRACT,
  DROP_CREATED_SELECTOR,
  STARKNET_COLLECTION_1155_CONTRACT,
  COLLECTION_DEPLOYED_SELECTOR,
  STARKNET_CREATOR_COIN_FACTORY_CONTRACT,
  CREATOR_COIN_CREATED_SELECTOR,
  STARKNET_IP_TICKETS_FACTORY_CONTRACT,
  STARKNET_IP_CLUB_REGISTRY_CONTRACT,
  NEW_CLUB_CREATED_SELECTOR,
  STARKNET_IP_SPONSORSHIP_CONTRACT,
  OFFER_CREATED_SELECTOR,
  OFFER_STATUS_UPDATED_SELECTOR,
  BID_PLACED_SELECTOR,
  BID_RETRACTED_SELECTOR,
  SPONSORSHIP_ACCEPTED_SELECTOR,
  LICENSE_TRANSFERRED_SELECTOR,
} from "../config/constants.js";
import type { RawStarknetEvent } from "../types/starknet.js";
import { num } from "starknet";

export interface PollResult {
  events: RawStarknetEvent[];
  fromBlock: number;
  toBlock: number;
}

async function pollContractEvents(params: {
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

/**
 * Fetch all events for a block range from the marketplace contract.
 * Handles continuation token pagination internally.
 */
export async function pollEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  return pollContractEvents({
    address: STARKNET_MARKETPLACE_721_CONTRACT,
    fromBlock,
    toBlock,
    keys: [[
      num.toHex(ORDER_CREATED_SELECTOR),
      num.toHex(ORDER_FULFILLED_SELECTOR),
      num.toHex(ORDER_CANCELLED_SELECTOR),
      num.toHex(COUNTER_INCREMENTED_SELECTOR),
    ]],
    maxPages: 100,
  });
}

/**
 * Fetch OrderCreated / OrderFulfilled / OrderCancelled events from the
 * Medialane1155 (ERC-1155 marketplace) contract. Same event selectors as the
 * ERC-721 marketplace; polled separately so handlers can tell contracts apart.
 */
export async function pollEvents1155(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!STARKNET_MARKETPLACE_1155_CONTRACT) return [];
  return pollContractEvents({
    address: STARKNET_MARKETPLACE_1155_CONTRACT,
    fromBlock,
    toBlock,
    keys: [[
      num.toHex(ORDER_CREATED_SELECTOR),
      num.toHex(ORDER_FULFILLED_SELECTOR),
      num.toHex(ORDER_CANCELLED_SELECTOR),
      num.toHex(COUNTER_INCREMENTED_SELECTOR),
    ]],
    maxPages: 100,
  });
}

/**
 * Fetch NFT transfer events for a specific collection contract.
 * Polls ERC-721 Transfer, ERC-1155 TransferSingle, and TransferBatch
 * in a single RPC call per page — no extra call volume vs before.
 */
export async function pollTransferEvents(
  contractAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  return pollContractEvents({
    address: contractAddress,
    fromBlock,
    toBlock,
    keys: [[
      num.toHex(TRANSFER_SELECTOR),
      num.toHex(TRANSFER_SINGLE_SELECTOR),
      num.toHex(TRANSFER_BATCH_SELECTOR),
    ]],
    maxPages: 100,
  });
}

/**
 * Fetch CollectionCreated events from the collection registry contract.
 */
export async function pollCollectionCreatedEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  return pollContractEvents({
    address: STARKNET_COLLECTION_721_CONTRACT,
    fromBlock,
    toBlock,
    keys: [[num.toHex(COLLECTION_CREATED_SELECTOR)]],
  });
}

/**
 * Fetch CommentAdded events from the NFTComments contract.
 * Returns an empty array when STARKNET_NFTCOMMENTS_CONTRACT is not configured.
 */
export async function pollCommentEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!STARKNET_NFTCOMMENTS_CONTRACT) return [];

  return pollContractEvents({
    address: STARKNET_NFTCOMMENTS_CONTRACT,
    fromBlock,
    toBlock,
    keys: [[num.toHex(COMMENT_ADDED_SELECTOR)]],
  });
}

/**
 * Fetch CollectionCreated events from the POP Protocol factory contract.
 * Returns an empty array when POP_FACTORY_ADDRESS is not configured.
 */
export async function pollPopFactoryEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!STARKNET_POP_FACTORY_CONTRACT) return [];

  return pollContractEvents({
    address: STARKNET_POP_FACTORY_CONTRACT,
    fromBlock,
    toBlock,
    keys: [[num.toHex(COLLECTION_CREATED_SELECTOR)]],
  });
}

/**
 * Fetch AllowlistUpdated events from a POP Protocol collection contract.
 */
export async function pollPopAllowlistEvents(
  collectionAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  return pollContractEvents({
    address: collectionAddress,
    fromBlock,
    toBlock,
    keys: [[num.toHex(POP_ALLOWLIST_UPDATED_SELECTOR)]],
  });
}

/**
 * Fetch DropCreated events from the Collection Drop factory contract.
 * Returns an empty array when DROP_FACTORY_ADDRESS is not configured.
 */
export async function pollDropFactoryEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!STARKNET_DROP_FACTORY_CONTRACT) return [];

  return pollContractEvents({
    address: STARKNET_DROP_FACTORY_CONTRACT,
    fromBlock,
    toBlock,
    keys: [[num.toHex(DROP_CREATED_SELECTOR)]],
  });
}

/**
 * Fetch AllowlistUpdated events from a Collection Drop collection contract.
 * Uses the same selector as POP Protocol AllowlistUpdated.
 */
export async function pollDropAllowlistEvents(
  collectionAddress: string,
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  return pollContractEvents({
    address: collectionAddress,
    fromBlock,
    toBlock,
    keys: [[num.toHex(POP_ALLOWLIST_UPDATED_SELECTOR)]],
  });
}

/**
 * Fetch CollectionDeployed events from the IP-Programmable-ERC1155-Collections factory.
 * Returns an empty array when STARKNET_COLLECTION_1155_CONTRACT is not configured.
 */
export async function pollERC1155FactoryEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!STARKNET_COLLECTION_1155_CONTRACT) return [];

  return pollContractEvents({
    address: STARKNET_COLLECTION_1155_CONTRACT,
    fromBlock,
    toBlock,
    keys: [[num.toHex(COLLECTION_DEPLOYED_SELECTOR)]],
  });
}

/**
 * Fetch CreatorCoinCreated events from the Creator Coin factory contract.
 * Returns an empty array when STARKNET_CREATOR_COIN_FACTORY_CONTRACT is not configured.
 */
export async function pollCreatorCoinFactoryEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!STARKNET_CREATOR_COIN_FACTORY_CONTRACT) return [];

  return pollContractEvents({
    address: STARKNET_CREATOR_COIN_FACTORY_CONTRACT,
    fromBlock,
    toBlock,
    keys: [[num.toHex(CREATOR_COIN_CREATED_SELECTOR)]],
  });
}

/**
 * Fetch CollectionDeployed events from the IP-Tickets factory.
 * Returns an empty array when STARKNET_IP_TICKETS_FACTORY_CONTRACT is not configured (not deployed yet).
 */
export async function pollTicketFactoryEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!STARKNET_IP_TICKETS_FACTORY_CONTRACT) return [];

  return pollContractEvents({
    address: STARKNET_IP_TICKETS_FACTORY_CONTRACT,
    fromBlock,
    toBlock,
    keys: [[num.toHex(COLLECTION_DEPLOYED_SELECTOR)]],
  });
}

/**
 * Fetch NewClubCreated events from the IPClub registry.
 * Returns an empty array when STARKNET_IP_CLUB_REGISTRY_CONTRACT is not configured (not deployed yet).
 */
export async function pollClubFactoryEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!STARKNET_IP_CLUB_REGISTRY_CONTRACT) return [];

  return pollContractEvents({
    address: STARKNET_IP_CLUB_REGISTRY_CONTRACT,
    fromBlock,
    toBlock,
    keys: [[num.toHex(NEW_CLUB_CREATED_SELECTOR)]],
  });
}

/**
 * Fetch all IPSponsorship events (OfferCreated/OfferStatusUpdated/BidPlaced/
 * BidRetracted/SponsorshipAccepted/LicenseTransferred) in one call — a single
 * key-position OR filter, since IPSponsorship is not a Collection factory and
 * has no per-instance addresses to fan out to. Returns an empty array when
 * STARKNET_IP_SPONSORSHIP_CONTRACT is not configured (not deployed yet).
 */
export async function pollSponsorshipEvents(
  fromBlock: number,
  toBlock: number
): Promise<RawStarknetEvent[]> {
  if (!STARKNET_IP_SPONSORSHIP_CONTRACT) return [];

  return pollContractEvents({
    address: STARKNET_IP_SPONSORSHIP_CONTRACT,
    fromBlock,
    toBlock,
    keys: [[
      num.toHex(OFFER_CREATED_SELECTOR),
      num.toHex(OFFER_STATUS_UPDATED_SELECTOR),
      num.toHex(BID_PLACED_SELECTOR),
      num.toHex(BID_RETRACTED_SELECTOR),
      num.toHex(SPONSORSHIP_ACCEPTED_SELECTOR),
      num.toHex(LICENSE_TRANSFERRED_SELECTOR),
    ]],
  });
}

export async function getLatestBlock(): Promise<number> {
  const block = await callRpc((provider) => provider.getBlockWithTxHashes("latest"));
  return (block as any).block_number as number;
}
