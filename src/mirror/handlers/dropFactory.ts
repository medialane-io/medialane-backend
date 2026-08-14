import { num } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { ZERO_ADDRESS } from "../../config/constants.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:dropFactory");

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
    const organizer = normalizeAddress("STARKNET", keys[3]);
    const collectionAddress = normalizeAddress("STARKNET", data[0]);

    if (collectionAddress === ZERO_ADDRESS) {
      log.warn({ txHash, dropId }, "DropCreated has zero collection_address, skipping");
      return;
    }

    const startBlock = BigInt(event.block_number ?? 0);

    await upsertCollectionFromFactory(prisma, {
      chain: "STARKNET",
      contractAddress: collectionAddress,
      service: "drop-collection",
      standard: "ERC721",
      collectionId: dropId,
      owner: organizer,
      startBlock,
    });

    worker.enqueue({ type: "COLLECTION_METADATA_FETCH", chain: "STARKNET", contractAddress: collectionAddress });

    log.info({ dropId, collectionAddress, organizer }, "Drop collection indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleDropCreated failed");
    throw err;
  }
}

export async function handleDropAllowlistUpdated(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const keys = event.keys.map((k) => num.toHex(k));
    const data = event.data;

    if (keys.length < 2 || !data || data.length < 1) {
      log.warn({ txHash }, "Drop AllowlistUpdated: unexpected key/data length, skipping");
      return;
    }

    const collectionAddress = normalizeAddress("STARKNET", event.from_address);
    const walletAddress = normalizeAddress("STARKNET", keys[1]);
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
