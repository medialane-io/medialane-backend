import { num } from "starknet";
import type { ParsedCollectionCreated } from "../../types/marketplace.js";
import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import { STARKNET_COLLECTION_721_CONTRACT } from "../../config/constants.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("handler:collectionCreated");

export interface ResolvedCollection {
  contractAddress: string;
  owner: string;
  name: string | null;
  symbol: string | null;
  baseUri: string | null;
  startBlock: bigint;
}

export interface DecodedCollectionCreated {
  collectionId: string;
  owner: string;
}

/**
 * Decode the audited CollectionCreated event layout (MIP-Collections-ERC721 v3,
 * deployed 2026-05-14). collection_id is a `#[key]` u256 emitted as low+high in
 * keys[1..2]; owner is the first data field.
 *
 * Returns null when keys/data are malformed. Single source of truth — when the
 * event shape changes again, this is the only place to update.
 */
export function decodeCollectionCreatedEvent(
  event: { keys?: string[]; data?: string[] }
): DecodedCollectionCreated | null {
  const { keys, data } = event;
  if (!keys || keys.length < 3 || !data || data.length < 1) return null;
  return {
    collectionId: (BigInt(keys[1]) + (BigInt(keys[2]) << 128n)).toString(),
    owner: normalizeAddress("STARKNET", data[0]),
  };
}

/**
 * Decode Cairo ByteArray raw felts from provider.callContract().
 * Raw layout: [data_len, ...31-byte chunks, pending_word, pending_word_len].
 */
function decodeByteArray(felts: string[], offset: number): { value: string; nextOffset: number } {
  if (offset >= felts.length) return { value: "", nextOffset: offset };
  const dataLen = Number(BigInt(felts[offset]));
  if (felts.length < offset + 1 + dataLen + 2) return { value: "", nextOffset: felts.length };

  const pendingWord = BigInt(felts[offset + 1 + dataLen] ?? "0x0");
  const pendingWordLen = Number(BigInt(felts[offset + 1 + dataLen + 1] ?? "0"));
  const bytes = new Uint8Array(dataLen * 31 + pendingWordLen);
  let byteOffset = 0;

  for (let i = 0; i < dataLen; i++) {
    const value = BigInt(felts[offset + 1 + i]);
    for (let j = 0; j < 31; j++) {
      bytes[byteOffset++] = Number((value >> BigInt((30 - j) * 8)) & 0xffn);
    }
  }

  for (let j = 0; j < pendingWordLen; j++) {
    bytes[byteOffset++] = Number((pendingWord >> BigInt((pendingWordLen - 1 - j) * 8)) & 0xffn);
  }

  return {
    value: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    nextOffset: offset + 1 + dataLen + 2,
  };
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
    const id = BigInt(collectionId);
    const low = id & ((1n << 128n) - 1n);
    const high = id >> 128n;
    const raw = (await callRpc((provider) => provider.callContract({
      contractAddress: STARKNET_COLLECTION_721_CONTRACT,
      entrypoint: "get_collection",
      calldata: [num.toHex(low), num.toHex(high)],
    }))) as unknown as string[];

    if (!raw || raw.length < 3) {
      log.warn({ collectionId }, "get_collection returned an empty response");
      return null;
    }

    const { value: name, nextOffset: afterName } = decodeByteArray(raw, 0);
    const { value: symbol, nextOffset: afterSymbol } = decodeByteArray(raw, afterName);
    const { value: baseUri, nextOffset: afterBaseUri } = decodeByteArray(raw, afterSymbol);
    const ownerRaw = raw[afterBaseUri];
    const ipNftRaw = raw[afterBaseUri + 1];
    if (!ipNftRaw) {
      log.warn({ collectionId }, "get_collection returned no ip_nft");
      return null;
    }

    const contractAddress = normalizeAddress("STARKNET", ipNftRaw);

    if (contractAddress === "0x" + "0".repeat(64)) {
      log.warn({ collectionId }, "ip_nft is zero address, skipping");
      return null;
    }

    const resolvedOwner = ownerRaw ? normalizeAddress("STARKNET", ownerRaw) : owner;

    log.info({ collectionId, contractAddress, owner: resolvedOwner, name }, "CollectionCreated resolved");

    return {
      contractAddress,
      owner: resolvedOwner,
      name: name || null,
      symbol: symbol || null,
      baseUri: baseUri || null,
      startBlock: blockNumber,
    };
  } catch (err) {
    log.error({ err, collectionId }, "Failed to resolve CollectionCreated event");
    return null;
  }
}
