import { num } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:ip1155Factory");

/**
 * Handle a CollectionDeployed event from the IP-Programmable-ERC1155-Collections factory.
 *
 * Event key layout (Cairo 2.x, #[key] fields):
 *   keys[0] = selector("CollectionDeployed")
 *   keys[1] = collection_address (ContractAddress)
 *   keys[2] = owner             (ContractAddress)
 *
 * Event data layout (ByteArray fields — name + symbol):
 *   data[0..n] = name  (ByteArray: data felts + pending_word + pending_word_len)
 *   data[n..m] = symbol (ByteArray)
 *   We don't parse the ByteArrays here — COLLECTION_METADATA_FETCH will fetch them via RPC.
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

    await prisma.collection.upsert({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: collectionAddress } },
      create: {
        chain: "STARKNET",
        contractAddress: collectionAddress,
        owner,
        startBlock,
        source: "ERC1155_FACTORY",
        standard: "ERC1155",
        isKnown: true,
        metadataStatus: "PENDING",
      },
      update: {
        owner,
        isKnown: true,
      },
    });

    worker.enqueue({
      type: "COLLECTION_METADATA_FETCH",
      chain: "STARKNET",
      contractAddress: collectionAddress,
    });

    log.info({ collectionAddress, owner, txHash }, "ERC-1155 collection deployed and indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleIP1155CollectionDeployed failed");
  }
}
