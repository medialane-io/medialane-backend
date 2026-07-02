import { num } from "starknet";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:ipClub");

/**
 * Handle a NewClubCreated event from the IPClub registry.
 *
 * Event key layout (Cairo 2.x, #[key] fields):
 *   keys[0] = selector("NewClubCreated")
 *   keys[1] = club_id.low  (u256 split — low 128 bits)
 *   keys[2] = club_id.high (u256 split — high 128 bits)
 *   keys[3] = creator (ContractAddress)
 *
 * Event data layout (club_nft is NOT a key, unlike the Drop/POP/Tickets
 * factory's deployed address — IP-Club emits it as a plain data field):
 *   data[0] = club_nft (ContractAddress)
 *   data[1..] = metadata_uri ByteArray + timestamp (not parsed here —
 *   COLLECTION_METADATA_FETCH handles it).
 */
export function decodeNewClubCreatedEvent(
  event: RawStarknetEvent,
): { clubId: string; creator: string; clubAddress: string } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  const data = event.data;
  if (keys.length < 4 || !data || data.length < 1) return null;

  const clubIdLow = BigInt(keys[1]);
  const clubIdHigh = BigInt(keys[2]);
  return {
    clubId: ((clubIdHigh << 128n) | clubIdLow).toString(),
    creator: normalizeAddress("STARKNET", keys[3]),
    clubAddress: normalizeAddress("STARKNET", data[0]),
  };
}

export async function handleNewClubCreated(event: RawStarknetEvent): Promise<void> {
  const txHash = event.transaction_hash ?? "";
  try {
    const decoded = decodeNewClubCreatedEvent(event);
    if (!decoded) {
      log.warn({ txHash }, "NewClubCreated: unexpected key/data length, skipping");
      return;
    }

    const startBlock = BigInt(event.block_number ?? 0);

    await upsertCollectionFromFactory(prisma, {
      chain: "STARKNET",
      contractAddress: decoded.clubAddress,
      service: "ip-club",
      standard: "ERC721",
      collectionId: decoded.clubId,
      owner: decoded.creator,
      claimedBy: decoded.creator,
      startBlock,
    });

    worker.enqueue({
      type: "COLLECTION_METADATA_FETCH",
      chain: "STARKNET",
      contractAddress: decoded.clubAddress,
    });

    log.info({ clubId: decoded.clubId, clubAddress: decoded.clubAddress }, "IP-Club indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleNewClubCreated failed");
    throw err;
  }
}
