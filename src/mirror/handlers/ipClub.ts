import { num } from "starknet";
import prisma from "../../db/client.js";
import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import { upsertCollectionFromFactory } from "../../utils/collection.js";
import { worker } from "../../orchestrator/worker.js";
import { createLogger } from "../../utils/logger.js";
import {
  STARKNET_IP_CLUB_REGISTRY_CONTRACT,
  NEW_CLUB_CREATED_SELECTOR,
  CLUB_STATUS_UPDATED_SELECTOR,
  NEW_MEMBER_SELECTOR,
  MEMBER_LEFT_SELECTOR,
} from "../../config/constants.js";
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

/** keys = [selector, club_id.low, club_id.high]; data = [open, updated_at]. */
export function decodeClubStatusUpdatedEvent(
  event: RawStarknetEvent,
): { clubId: string; open: boolean } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  const data = event.data;
  if (keys.length < 3 || !data || data.length < 1) return null;
  const clubIdLow = BigInt(keys[1]);
  const clubIdHigh = BigInt(keys[2]);
  return {
    clubId: ((clubIdHigh << 128n) | clubIdLow).toString(),
    open: BigInt(data[0]) !== 0n,
  };
}

/** keys = [selector, club_id.low, club_id.high, member]. Shared by NewMember/MemberLeft. */
function decodeClubMembershipEvent(
  event: RawStarknetEvent,
): { clubId: string; member: string } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  if (keys.length < 4) return null;
  const clubIdLow = BigInt(keys[1]);
  const clubIdHigh = BigInt(keys[2]);
  return {
    clubId: ((clubIdHigh << 128n) | clubIdLow).toString(),
    member: normalizeAddress("STARKNET", keys[3]),
  };
}

export const decodeNewMemberEvent = decodeClubMembershipEvent;
export const decodeMemberLeftEvent = decodeClubMembershipEvent;

export interface ResolvedClubRecord {
  creator: string;
  clubNft: string;
  open: boolean;
  numMembers: number;
  maxMembers: number | null;
  entryFee: string | null;
  paymentToken: string | null;
}

/**
 * Resolve a club's full ClubRecord via get_club_record() — the registry's
 * own source of truth for open/entry-fee/member-cap, re-read on every event
 * that touches this club rather than trusted from incremental counters, so
 * it can never drift.
 *
 * ⚠️ Field-offset layout (Serde struct order from IP-Club/src/types.cairo
 * ClubRecord) has NOT been verified against a live emitted response — no
 * contract is deployed with real club activity yet. Same "verify after
 * deploy" caveat as sponsorshipPoller.ts's resolveOffer().
 */
export async function resolveClubRecord(clubId: string): Promise<ResolvedClubRecord | null> {
  try {
    const id = BigInt(clubId);
    const low = id & ((1n << 128n) - 1n);
    const high = id >> 128n;
    const raw = (await callRpc((provider) => provider.callContract({
      contractAddress: STARKNET_IP_CLUB_REGISTRY_CONTRACT,
      entrypoint: "get_club_record",
      calldata: [num.toHex(low), num.toHex(high)],
    }))) as unknown as string[];

    if (!raw || raw.length < 5) {
      log.warn({ clubId }, "get_club_record returned an unexpectedly short response");
      return null;
    }

    let i = 0;
    const creator = normalizeAddress("STARKNET", raw[i++]);
    const clubNft = normalizeAddress("STARKNET", raw[i++]);
    const open = BigInt(raw[i++]) !== 0n;
    const numMembers = Number(raw[i++]);
    const maxMembersVariant = BigInt(raw[i++]);
    const maxMembers = maxMembersVariant === 0n ? Number(raw[i++]) : null;
    const entryFeeVariant = BigInt(raw[i++]);
    let entryFee: string | null = null;
    if (entryFeeVariant === 0n) {
      entryFee = ((BigInt(raw[i + 1]) << 128n) | BigInt(raw[i])).toString();
      i += 2;
    }
    const paymentTokenVariant = BigInt(raw[i++]);
    const paymentToken = paymentTokenVariant === 0n ? normalizeAddress("STARKNET", raw[i++]) : null;

    return { creator, clubNft, open, numMembers, maxMembers, entryFee, paymentToken };
  } catch (err) {
    log.error({ err, clubId }, "resolveClubRecord failed");
    return null;
  }
}

async function upsertClubInfo(clubId: string, record: ResolvedClubRecord): Promise<void> {
  await prisma.clubInfo.upsert({
    where: {
      chain_registryAddress_clubId: {
        chain: "STARKNET",
        registryAddress: STARKNET_IP_CLUB_REGISTRY_CONTRACT,
        clubId,
      },
    },
    create: {
      chain: "STARKNET",
      registryAddress: STARKNET_IP_CLUB_REGISTRY_CONTRACT,
      clubId,
      clubNftAddress: record.clubNft,
      open: record.open,
      numMembers: record.numMembers,
      maxMembers: record.maxMembers,
      entryFee: record.entryFee,
      paymentToken: record.paymentToken,
    },
    update: {
      open: record.open,
      numMembers: record.numMembers,
      maxMembers: record.maxMembers,
      entryFee: record.entryFee,
      paymentToken: record.paymentToken,
    },
  });
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

    const record = await resolveClubRecord(decoded.clubId);
    if (record) await upsertClubInfo(decoded.clubId, record);

    log.info({ clubId: decoded.clubId, clubAddress: decoded.clubAddress }, "IP-Club indexed");
  } catch (err) {
    log.error({ err, txHash }, "handleNewClubCreated failed");
    throw err;
  }
}

async function refreshClubInfo(clubId: string): Promise<void> {
  const record = await resolveClubRecord(clubId);
  if (record) await upsertClubInfo(clubId, record);
}

export async function handleClubStatusUpdated(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeClubStatusUpdatedEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "ClubStatusUpdated: unexpected key/data length, skipping");
    return;
  }
  await refreshClubInfo(decoded.clubId);
}

export async function handleNewMember(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeNewMemberEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "NewMember: unexpected key length, skipping");
    return;
  }
  await refreshClubInfo(decoded.clubId);
}

export async function handleMemberLeft(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeMemberLeftEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "MemberLeft: unexpected key length, skipping");
    return;
  }
  await refreshClubInfo(decoded.clubId);
}

/** Dispatch a raw IPClub registry event to its handler by selector (keys[0]). */
export async function handleClubRegistryEvent(event: RawStarknetEvent): Promise<void> {
  const selector = num.toHex(event.keys[0] ?? "0x0");
  switch (selector) {
    case num.toHex(NEW_CLUB_CREATED_SELECTOR):
      return handleNewClubCreated(event);
    case num.toHex(CLUB_STATUS_UPDATED_SELECTOR):
      return handleClubStatusUpdated(event);
    case num.toHex(NEW_MEMBER_SELECTOR):
      return handleNewMember(event);
    case num.toHex(MEMBER_LEFT_SELECTOR):
      return handleMemberLeft(event);
    default:
      log.warn({ selector }, "handleClubRegistryEvent: unrecognized selector, skipping");
  }
}
