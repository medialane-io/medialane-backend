import { num } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:ip1155Factory");

/**
 * Decode a Cairo ByteArray from a flat array of felt hex strings starting at `offset`.
 * ByteArray layout: [data_len, ...data_chunks, pending_word, pending_word_len]
 */
function decodeByteArray(felts: string[], offset: number): { value: string; nextOffset: number } {
  if (offset >= felts.length) return { value: "", nextOffset: offset };
  const dataLen = Number(BigInt(felts[offset]));
  const chunks = felts.slice(offset + 1, offset + 1 + dataLen);
  const pendingWord = felts[offset + 1 + dataLen] ?? "0x0";
  const pendingWordLen = Number(BigInt(felts[offset + 1 + dataLen + 1] ?? "0"));

  let value = "";
  for (const chunk of chunks) {
    const hex = BigInt(chunk).toString(16).padStart(62, "0");
    for (let i = 0; i < 31; i++) {
      const code = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      if (code > 0) value += String.fromCharCode(code);
    }
  }
  if (pendingWordLen > 0) {
    const hex = BigInt(pendingWord).toString(16).padStart(pendingWordLen * 2, "0");
    for (let i = 0; i < pendingWordLen; i++) {
      const code = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      if (code > 0) value += String.fromCharCode(code);
    }
  }

  return { value, nextOffset: offset + 1 + dataLen + 2 };
}

/**
 * Handle a CollectionDeployed event from the IP-Programmable-ERC1155-Collections factory.
 *
 * Event key layout (Cairo 2.x, #[key] fields):
 *   keys[0] = selector("CollectionDeployed")
 *   keys[1] = collection_address (ContractAddress)
 *   keys[2] = owner             (ContractAddress)
 *
 * Event data layout (ByteArray fields, v2 factory):
 *   data[0..n] = name     (ByteArray: data_len, ...chunks, pending_word, pending_word_len)
 *   data[n..m] = symbol   (ByteArray)
 *   data[m..p] = base_uri (ByteArray)
 */
export async function handleIP1155CollectionDeployed(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const keys = event.keys.map((k) => num.toHex(k));

    if (keys.length < 3) {
      log.warn({ txHash }, "CollectionDeployed: unexpected key length, skipping");
      return;
    }

    const collectionAddress = normalizeAddress(keys[1]);
    const owner = normalizeAddress(keys[2]);

    if (collectionAddress === ZERO_ADDRESS) {
      log.warn({ txHash }, "CollectionDeployed has zero collection_address, skipping");
      return;
    }

    const startBlock = BigInt(event.block_number ?? 0);

    const dataFelts = (event.data ?? []).map((d) => num.toHex(d));
    const { value: name, nextOffset: afterName } = decodeByteArray(dataFelts, 0);
    const { value: symbol, nextOffset: afterSymbol } = decodeByteArray(dataFelts, afterName);
    const { value: baseUri } = decodeByteArray(dataFelts, afterSymbol);

    await prisma.collection.upsert({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: collectionAddress } },
      create: {
        chain: "STARKNET",
        contractAddress: collectionAddress,
        name: name || null,
        symbol: symbol || null,
        baseUri: baseUri || null,
        owner,
        startBlock,
        source: "ERC1155_FACTORY",
        standard: "ERC1155",
        metadataStatus: "PENDING",
      },
      update: {
        name: name || undefined,
        symbol: symbol || undefined,
        baseUri: baseUri || undefined,
        owner,
        source: "ERC1155_FACTORY",
        standard: "ERC1155",
      },
    });

    worker.enqueue({
      type: "COLLECTION_METADATA_FETCH",
      chain: "STARKNET",
      contractAddress: collectionAddress,
    });

    log.info({ collectionAddress, owner, name, symbol, baseUri, txHash }, "ERC-1155 collection deployed and indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleIP1155CollectionDeployed failed");
  }
}
