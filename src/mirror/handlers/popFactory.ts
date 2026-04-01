import { num } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:popFactory");

/**
 * Handle a CollectionCreated event from the POP Protocol factory.
 *
 * Event key layout (Cairo 2.x, #[key] fields):
 *   keys[0] = selector("CollectionCreated")
 *   keys[1] = collection_id.low  (u256 split — low 128 bits)
 *   keys[2] = collection_id.high (u256 split — high 128 bits)
 *   keys[3] = organizer (ContractAddress)
 *
 * Event data layout:
 *   data[0] = collection_address (ContractAddress)
 *   data[1] = event_type (felt252 enum)
 *   data[2..] = name ByteArray + timestamp (not parsed — COLLECTION_METADATA_FETCH handles it)
 */
export async function handlePopCollectionCreated(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const keys = event.keys.map((k) => num.toHex(k));
    const data = event.data;

    if (keys.length < 4 || !data || data.length < 1) {
      log.warn({ txHash }, "POP CollectionCreated: unexpected key/data length, skipping");
      return;
    }

    const collectionIdLow = BigInt(keys[1]);
    const collectionIdHigh = BigInt(keys[2]);
    const collectionId = ((collectionIdHigh << 128n) | collectionIdLow).toString();
    const organizer = normalizeAddress(keys[3]);
    const collectionAddress = normalizeAddress(data[0]);

    if (collectionAddress === ZERO_ADDRESS) {
      log.warn({ txHash, collectionId }, "POP CollectionCreated has zero collection_address, skipping");
      return;
    }

    const startBlock = BigInt(event.block_number ?? 0);

    await prisma.collection.upsert({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: collectionAddress } },
      create: {
        chain: "STARKNET",
        contractAddress: collectionAddress,
        collectionId,
        owner: organizer,
        startBlock,
        source: "POP_PROTOCOL",
        isKnown: true,
        metadataStatus: "PENDING",
      },
      update: {
        // Don't overwrite admin-set values; keep collectionId + owner in sync
        collectionId,
        owner: organizer,
        source: "POP_PROTOCOL",
      },
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: collectionAddress });

    log.info({ collectionId, collectionAddress, organizer }, "POP collection indexed");
  } catch (err) {
    log.error({ err, txHash }, "handlePopCollectionCreated failed");
    throw err;
  }
}

/**
 * Handle an AllowlistUpdated event from a POP Protocol collection.
 *
 * Event key layout:
 *   keys[0] = selector("AllowlistUpdated")
 *   keys[1] = user (ContractAddress)
 *
 * Event data layout:
 *   data[0] = allowed (bool as 0x0 or 0x1)
 *   data[1] = timestamp (u64)
 *
 * The collection address is event.from_address.
 */
export async function handlePopAllowlistUpdated(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const keys = event.keys.map((k) => num.toHex(k));
    const data = event.data;

    if (keys.length < 2 || !data || data.length < 1) {
      log.warn({ txHash }, "AllowlistUpdated: unexpected key/data length, skipping");
      return;
    }

    const collectionAddress = normalizeAddress(event.from_address);
    const walletAddress = normalizeAddress(keys[1]);
    const allowed = BigInt(data[0]) !== 0n;

    await prisma.popAllowlist.upsert({
      where: {
        chain_collectionAddress_walletAddress: {
          chain: "STARKNET",
          collectionAddress,
          walletAddress,
        },
      },
      create: { chain: "STARKNET", collectionAddress, walletAddress, allowed },
      update: { allowed },
    });

    log.debug({ collectionAddress, walletAddress, allowed }, "AllowlistUpdated indexed");
  } catch (err) {
    log.error({ err, txHash }, "handlePopAllowlistUpdated failed");
    throw err;
  }
}
