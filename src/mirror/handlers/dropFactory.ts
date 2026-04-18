import { num } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:dropFactory");

/**
 * Handle a DropCreated event from the Collection Drop factory.
 *
 * Event key layout (Cairo 2.x, #[key] fields):
 *   keys[0] = selector("DropCreated")
 *   keys[1] = drop_id.low  (u256 split — low 128 bits)
 *   keys[2] = drop_id.high (u256 split — high 128 bits)
 *   keys[3] = organizer (ContractAddress)
 *
 * Event data layout:
 *   data[0] = collection_address (ContractAddress)
 *   data[1..] = name ByteArray + max_supply u256 + timestamp u64 (not parsed — COLLECTION_METADATA_FETCH handles it)
 */
export async function handleDropCreated(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const keys = event.keys.map((k) => num.toHex(k));
    const data = event.data;

    if (keys.length < 4 || !data || data.length < 1) {
      log.warn({ txHash }, "DropCreated: unexpected key/data length, skipping");
      return;
    }

    const dropIdLow = BigInt(keys[1]);
    const dropIdHigh = BigInt(keys[2]);
    const dropId = ((dropIdHigh << 128n) | dropIdLow).toString();
    const organizer = normalizeAddress(keys[3]);
    const collectionAddress = normalizeAddress(data[0]);

    if (collectionAddress === ZERO_ADDRESS) {
      log.warn({ txHash, dropId }, "DropCreated has zero collection_address, skipping");
      return;
    }

    const startBlock = BigInt(event.block_number ?? 0);

    await prisma.collection.upsert({
      where: { chain_contractAddress: { chain: "STARKNET", contractAddress: collectionAddress } },
      create: {
        chain: "STARKNET",
        contractAddress: collectionAddress,
        collectionId: dropId,
        owner: organizer,
        startBlock,
        source: "COLLECTION_DROP",
        metadataStatus: "PENDING",
      },
      update: {
        collectionId: dropId,
        owner: organizer,
        source: "COLLECTION_DROP",
      },
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: collectionAddress });

    log.info({ dropId, collectionAddress, organizer }, "Drop collection indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleDropCreated failed");
    throw err;
  }
}

/**
 * Handle an AllowlistUpdated event from a Collection Drop collection.
 * Layout is identical to POP Protocol AllowlistUpdated — stored in the same PopAllowlist table.
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
export async function handleDropAllowlistUpdated(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const keys = event.keys.map((k) => num.toHex(k));
    const data = event.data;

    if (keys.length < 2 || !data || data.length < 1) {
      log.warn({ txHash }, "Drop AllowlistUpdated: unexpected key/data length, skipping");
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

    log.debug({ collectionAddress, walletAddress, allowed }, "Drop AllowlistUpdated indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleDropAllowlistUpdated failed");
    throw err;
  }
}
