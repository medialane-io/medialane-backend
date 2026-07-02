import { num } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:ticketCollectionFactory");

/**
 * Handle a CollectionDeployed event from the IP-Tickets factory.
 *
 * Event key layout (Cairo 2.x, #[key] fields — IPTicketCollectionFactory):
 *   keys[0] = selector("CollectionDeployed")
 *   keys[1] = collection_address (ContractAddress — single felt, no u256 split)
 *   keys[2] = owner (ContractAddress)
 *
 * Event data layout:
 *   data[...] = name ByteArray + symbol ByteArray (not parsed here —
 *   COLLECTION_METADATA_FETCH handles it, same as pop/drop).
 */
export function decodeCollectionDeployedEvent(
  event: RawStarknetEvent,
): { collectionAddress: string; owner: string } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  if (keys.length < 3) return null;
  return {
    collectionAddress: normalizeAddress("STARKNET", keys[1]),
    owner: normalizeAddress("STARKNET", keys[2]),
  };
}

export async function handleTicketCollectionDeployed(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const decoded = decodeCollectionDeployedEvent(event);
    if (!decoded) {
      log.warn({ txHash }, "TicketCollectionDeployed: unexpected key length, skipping");
      return;
    }

    const startBlock = BigInt(event.block_number ?? 0);

    await upsertCollectionFromFactory(prisma, {
      chain: "STARKNET",
      contractAddress: decoded.collectionAddress,
      service: "ip-tickets",
      standard: "ERC721",
      owner: decoded.owner,
      claimedBy: decoded.owner,
      startBlock,
    });

    worker.enqueue({
      type: "COLLECTION_METADATA_FETCH",
      chain: "STARKNET",
      contractAddress: decoded.collectionAddress,
    });

    log.info(
      { collectionAddress: decoded.collectionAddress, owner: decoded.owner },
      "IP-Tickets collection indexed",
    );
  } catch (err) {
    log.error({ err, txHash }, "handleTicketCollectionDeployed failed");
    throw err;
  }
}
