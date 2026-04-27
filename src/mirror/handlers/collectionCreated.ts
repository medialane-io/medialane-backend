import { Contract, cairo, num } from "starknet";
import type { ParsedCollectionCreated } from "../../types/marketplace.js";
import { normalizeAddress, createProvider } from "../../utils/starknet.js";
import { COLLECTION_721_CONTRACT } from "../../config/constants.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:collectionCreated");

const REGISTRY_ABI = [
  {
    type: "struct",
    name: "core::byte_array::ByteArray",
    members: [
      { name: "data", type: "core::array::Array::<core::felt252>" },
      { name: "pending_word", type: "core::felt252" },
      { name: "pending_word_len", type: "core::integer::u32" },
    ],
  },
  {
    type: "struct",
    name: "ip_collection_erc_721::types::Collection",
    members: [
      { name: "name", type: "core::byte_array::ByteArray" },
      { name: "symbol", type: "core::byte_array::ByteArray" },
      { name: "base_uri", type: "core::byte_array::ByteArray" },
      { name: "owner", type: "core::starknet::contract_address::ContractAddress" },
      { name: "ip_nft", type: "core::starknet::contract_address::ContractAddress" },
      { name: "is_active", type: "core::bool" },
    ],
  },
  {
    type: "function",
    name: "get_collection",
    inputs: [{ name: "collection_id", type: "core::integer::u256" }],
    outputs: [{ type: "ip_collection_erc_721::types::Collection" }],
    state_mutability: "view",
  },
] as const;

export interface ResolvedCollection {
  contractAddress: string;
  owner: string;
  name: string | null;
  symbol: string | null;
  baseUri: string | null;
  startBlock: bigint;
}

/**
 * Resolve a CollectionCreated event by calling get_collection() on the registry
 * to get the ip_nft (ERC-721 contract address).
 * Returns a ResolvedCollection to be upserted into the DB after the tx commits.
 */
export async function resolveCollectionCreated(
  event: ParsedCollectionCreated
): Promise<ResolvedCollection | null> {
  const { collectionId, owner, blockNumber } = event;

  try {
    const provider = createProvider();
    const contract = new Contract(REGISTRY_ABI as any, COLLECTION_721_CONTRACT, provider);
    const id = BigInt(collectionId);
    const col = await (contract as any).get_collection(cairo.uint256(id));

    const ipNftRaw = col.ip_nft ?? col["ip_nft"];
    if (!ipNftRaw) {
      log.warn({ collectionId }, "get_collection returned no ip_nft");
      return null;
    }

    const contractAddress = normalizeAddress(
      "0x" + num.toBigInt(ipNftRaw.toString()).toString(16)
    );

    if (contractAddress === "0x" + "0".repeat(64)) {
      log.warn({ collectionId }, "ip_nft is zero address, skipping");
      return null;
    }

    const name = typeof col.name === "string" && col.name ? col.name : null;
    const symbol = typeof col.symbol === "string" && col.symbol ? col.symbol : null;
    const baseUri = typeof col.base_uri === "string" && col.base_uri ? col.base_uri : null;

    log.info({ collectionId, contractAddress, owner, name }, "CollectionCreated resolved");

    return { contractAddress, owner, name, symbol, baseUri, startBlock: blockNumber };
  } catch (err) {
    log.error({ err, collectionId }, "Failed to resolve CollectionCreated event");
    return null;
  }
}
