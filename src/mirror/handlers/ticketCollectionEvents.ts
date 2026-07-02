import { num } from "starknet";
import prisma from "../../db/client.js";
import { callRpc, normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import {
  TICKET_COLLECTION_CREATED_SELECTOR,
  TICKET_MINTED_SELECTOR,
  TICKET_REDEEMED_SELECTOR,
} from "../../config/constants.js";
import type { RawStarknetEvent } from "../../types/starknet.js";

const log = createLogger("mirror:ticketCollectionEvents");

/**
 * Handle the INNER per-batch events emitted by one deployed
 * IPTicketCollection instance — distinct from ticketCollectionFactory.ts,
 * which only discovers the outer, per-creator deployed contract. One
 * creator's contract can hold multiple ticket collections (events/tiers),
 * each with its own price/expiration/active state (TicketCollectionInfo).
 * Polled on a slow per-instance schedule (mirror/index.ts), same shape as
 * POP/Drop's AllowlistUpdated.
 */

/**
 * Event key layout (IPTicketCollection, Cairo 2.x, #[key] fields):
 *   keys[0] = selector("TicketCollectionCreated")
 *   keys[1] = collection_id.low  (u256 split)
 *   keys[2] = collection_id.high
 *   keys[3] = creator (ContractAddress)
 * Event data: price, max_supply, expiration, royalty_bps, payment_token,
 * metadata_uri, created_at — NOT parsed here; resolveTicketCollection()
 * re-reads the full struct via get_ticket_collection() instead, since
 * metadata_uri is a variable-length ByteArray sandwiched between an
 * Option<ContractAddress> and fixed fields (same approach as
 * sponsorshipPoller.ts's resolveOffer()).
 */
export function decodeTicketCollectionCreatedEvent(
  event: RawStarknetEvent,
): { collectionId: string; creator: string } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  if (keys.length < 4) return null;
  const idLow = BigInt(keys[1]);
  const idHigh = BigInt(keys[2]);
  return {
    collectionId: ((idHigh << 128n) | idLow).toString(),
    creator: normalizeAddress("STARKNET", keys[3]),
  };
}

/**
 * Event key layout (shared by TicketMinted and TicketRedeemed):
 *   keys[0] = selector
 *   keys[1] = token_id.low
 *   keys[2] = token_id.high
 *   keys[3] = collection_id.low
 *   keys[4] = collection_id.high
 *   keys[5] = owner (ContractAddress)
 * Both events carry only a single u64 timestamp in data — not needed here.
 */
function decodeTokenCollectionKeyed(
  event: RawStarknetEvent,
): { tokenId: string; collectionId: string; owner: string } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  if (keys.length < 6) return null;
  const tokenIdLow = BigInt(keys[1]);
  const tokenIdHigh = BigInt(keys[2]);
  const collectionIdLow = BigInt(keys[3]);
  const collectionIdHigh = BigInt(keys[4]);
  return {
    tokenId: ((tokenIdHigh << 128n) | tokenIdLow).toString(),
    collectionId: ((collectionIdHigh << 128n) | collectionIdLow).toString(),
    owner: normalizeAddress("STARKNET", keys[5]),
  };
}

export function decodeTicketMintedEvent(event: RawStarknetEvent) {
  return decodeTokenCollectionKeyed(event);
}

export function decodeTicketRedeemedEvent(event: RawStarknetEvent) {
  return decodeTokenCollectionKeyed(event);
}

// Same canonical ByteArray decode pattern as collectionCreated.ts /
// sponsorshipPoller.ts. Raw layout: [data_len, ...31-byte chunks, pending_word, pending_word_len].
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

export interface ResolvedTicketCollection {
  price: string;
  maxSupply: string;
  minted: string;
  expiration: bigint;
  royaltyBps: number;
  paymentToken: string | null;
  metadataUri: string;
  active: boolean;
}

/**
 * ⚠️ Field-offset layout (Serde struct order from IP-Tickets/src/types.cairo
 * TicketCollection) has NOT been verified against a live emitted response —
 * no contract is deployed yet. Verify before trusting in production, same
 * caveat as sponsorshipPoller.ts's resolveOffer()/resolveLicense().
 */
export async function resolveTicketCollection(
  contractAddress: string,
  collectionId: string,
): Promise<ResolvedTicketCollection | null> {
  try {
    const id = BigInt(collectionId);
    const low = id & ((1n << 128n) - 1n);
    const high = id >> 128n;
    const raw = (await callRpc((provider) => provider.callContract({
      contractAddress,
      entrypoint: "get_ticket_collection",
      calldata: [num.toHex(low), num.toHex(high)],
    }))) as unknown as string[];

    if (!raw || raw.length < 8) {
      log.warn({ contractAddress, collectionId }, "get_ticket_collection returned an unexpectedly short response");
      return null;
    }

    // TicketCollection field order: creator, price, max_supply, minted,
    // expiration, royalty_bps, payment_token, metadata_uri, active.
    let i = 1; // skip creator — the caller already has it from the event key
    const price = ((BigInt(raw[i + 1]) << 128n) | BigInt(raw[i])).toString();
    i += 2;
    const maxSupply = ((BigInt(raw[i + 1]) << 128n) | BigInt(raw[i])).toString();
    i += 2;
    const minted = ((BigInt(raw[i + 1]) << 128n) | BigInt(raw[i])).toString();
    i += 2;
    const expiration = BigInt(raw[i++]);
    const royaltyBps = Number(((BigInt(raw[i + 1]) << 128n) | BigInt(raw[i])) & 0xffffn);
    i += 2;
    const paymentTokenVariant = BigInt(raw[i++]);
    const paymentToken = paymentTokenVariant === 0n ? normalizeAddress("STARKNET", raw[i++]) : null;
    const { value: metadataUri, nextOffset } = decodeByteArray(raw, i);
    i = nextOffset;
    const active = BigInt(raw[i++]) !== 0n;

    return { price, maxSupply, minted, expiration, royaltyBps, paymentToken, metadataUri, active };
  } catch (err) {
    log.error({ err, contractAddress, collectionId }, "resolveTicketCollection failed");
    return null;
  }
}

export async function handleTicketCollectionCreated(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeTicketCollectionCreatedEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "TicketCollectionCreated: unexpected key length, skipping");
    return;
  }
  const contractAddress = normalizeAddress("STARKNET", event.from_address);
  const resolved = await resolveTicketCollection(contractAddress, decoded.collectionId);
  if (!resolved) return;

  await prisma.ticketCollectionInfo.upsert({
    where: {
      chain_contractAddress_ticketCollectionId: {
        chain: "STARKNET",
        contractAddress,
        ticketCollectionId: decoded.collectionId,
      },
    },
    create: {
      chain: "STARKNET",
      contractAddress,
      ticketCollectionId: decoded.collectionId,
      price: resolved.price,
      maxSupply: resolved.maxSupply,
      minted: resolved.minted,
      expiration: resolved.expiration,
      royaltyBps: resolved.royaltyBps,
      paymentToken: resolved.paymentToken,
      metadataUri: resolved.metadataUri,
      active: resolved.active,
    },
    update: { minted: resolved.minted, active: resolved.active },
  });

  log.info({ contractAddress, collectionId: decoded.collectionId }, "Ticket collection indexed");
}

export async function handleTicketMinted(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeTicketMintedEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "TicketMinted: unexpected key length, skipping");
    return;
  }
  const contractAddress = normalizeAddress("STARKNET", event.from_address);

  // The Token row is created by the generic Transfer(mint) handler, which
  // runs on the main per-tick loop — much more frequently than this slow
  // per-instance loop — so it should already exist by the time this runs.
  // Best-effort update; a missed race self-heals on the next mint's poll if
  // this handler ever needs to be reprocessed for the same block range.
  await prisma.token.updateMany({
    where: { chain: "STARKNET", contractAddress, tokenId: decoded.tokenId },
    data: { ticketCollectionId: decoded.collectionId },
  });

  const info = await prisma.ticketCollectionInfo.findUnique({
    where: { chain_contractAddress_ticketCollectionId: { chain: "STARKNET", contractAddress, ticketCollectionId: decoded.collectionId } },
    select: { minted: true },
  });
  if (info) {
    await prisma.ticketCollectionInfo.update({
      where: { chain_contractAddress_ticketCollectionId: { chain: "STARKNET", contractAddress, ticketCollectionId: decoded.collectionId } },
      data: { minted: (BigInt(info.minted) + 1n).toString() },
    });
  }
}

export async function handleTicketRedeemed(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeTicketRedeemedEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "TicketRedeemed: unexpected key length, skipping");
    return;
  }
  const contractAddress = normalizeAddress("STARKNET", event.from_address);

  await prisma.token.updateMany({
    where: { chain: "STARKNET", contractAddress, tokenId: decoded.tokenId },
    data: { redeemed: true },
  });
}

/** Dispatch a raw IPTicketCollection inner event to its handler by selector (keys[0]). */
export async function handleTicketCollectionEvent(event: RawStarknetEvent): Promise<void> {
  const selector = num.toHex(event.keys[0] ?? "0x0");
  switch (selector) {
    case num.toHex(TICKET_COLLECTION_CREATED_SELECTOR):
      return handleTicketCollectionCreated(event);
    case num.toHex(TICKET_MINTED_SELECTOR):
      return handleTicketMinted(event);
    case num.toHex(TICKET_REDEEMED_SELECTOR):
      return handleTicketRedeemed(event);
    default:
      log.warn({ selector }, "handleTicketCollectionEvent: unrecognized selector, skipping");
  }
}
