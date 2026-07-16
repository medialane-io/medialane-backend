import { num } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:ipClubFactory");

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
 * Handle a ClubDeployed event from the IP Club factory.
 *
 * Event key layout (identical shape to IP Tickets' CollectionDeployed):
 *   keys[0] = selector("ClubDeployed")
 *   keys[1] = collection_address (ContractAddress)
 *   keys[2] = owner              (ContractAddress)
 *
 * Event data layout (ByteArray fields):
 *   data[0..n] = name   (ByteArray)
 *   data[n..m] = symbol (ByteArray)
 *
 * base_uri is not in the event — the collection exposes it on-chain and the
 * COLLECTION_METADATA_FETCH job reads it.
 */
export async function handleIPClubDeployed(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const keys = event.keys.map((k) => num.toHex(k));

    if (keys.length < 3) {
      log.warn({ txHash }, "ClubDeployed: unexpected key length, skipping");
      return;
    }

    const collectionAddress = normalizeAddress("STARKNET", keys[1]);
    const owner = normalizeAddress("STARKNET", keys[2]);

    if (collectionAddress === ZERO_ADDRESS) {
      log.warn({ txHash }, "ClubDeployed has zero collection_address, skipping");
      return;
    }

    const startBlock = BigInt(event.block_number ?? 0);

    const dataFelts = (event.data ?? []).map((d) => num.toHex(d));
    const { value: name, nextOffset: afterName } = decodeByteArray(dataFelts, 0);
    const { value: symbol } = decodeByteArray(dataFelts, afterName);

    await upsertCollectionFromFactory(prisma, {
      chain: "STARKNET",
      contractAddress: collectionAddress,
      service: "ip-club",
      standard: "ERC1155",
      name: name || null,
      symbol: symbol || null,
      baseUri: null,
      owner,
      startBlock,
    });

    worker.enqueue({
      type: "COLLECTION_METADATA_FETCH",
      chain: "STARKNET",
      contractAddress: collectionAddress,
    });

    log.info({ collectionAddress, owner, name, symbol, txHash }, "IP Club collection deployed and indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleIPClubDeployed failed");
  }
}
