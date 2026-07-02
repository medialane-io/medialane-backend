import { num } from "starknet";
import prisma from "../db/client.js";
import { callRpc, normalizeAddress } from "../utils/starknet.js";
import {
  STARKNET_IP_SPONSORSHIP_CONTRACT,
  OFFER_CREATED_SELECTOR,
  OFFER_STATUS_UPDATED_SELECTOR,
  BID_PLACED_SELECTOR,
  BID_RETRACTED_SELECTOR,
  SPONSORSHIP_ACCEPTED_SELECTOR,
  LICENSE_TRANSFERRED_SELECTOR,
} from "../config/constants.js";
import { createLogger } from "../utils/logger.js";
import type { RawStarknetEvent } from "../types/starknet.js";

const log = createLogger("mirror:sponsorship");

/**
 * Handle events from the IPSponsorship contract. Unlike Tickets/Club, this
 * is neither a Collection factory nor a per-instance ERC-721 — IPSponsorship
 * mints nothing itself, so these decoders feed SponsorshipOffer/Bid/License
 * tables directly (see prisma/schema.prisma), not upsertCollectionFromFactory.
 * Runs on its own decoupled poll cadence + cursor (src/mirror/index.ts, same
 * shape as the Creator Coin factory poll), since it isn't visited by the main
 * Collection-factory mirror loop.
 */

/**
 * Event key layout (IPSponsorship, Cairo 2.x, #[key] fields):
 *   keys[0] = selector("OfferCreated")
 *   keys[1] = offer_id.low   (u256 split)
 *   keys[2] = offer_id.high
 *   keys[3] = author (ContractAddress)
 *   keys[4] = nft_contract (ContractAddress)
 * Event data: token_id, min_amount, duration, payment_token,
 *   license_terms_uri, transferable, specific_sponsor, created_at — NOT
 *   parsed from event data; resolveOffer() below re-reads the full struct
 *   via get_offer() instead (mirrors resolveCollectionCreated's approach),
 *   since license_terms_uri is a variable-length ByteArray sandwiched
 *   between an Option<ContractAddress> and fixed fields.
 */
export function decodeOfferCreatedEvent(
  event: RawStarknetEvent,
): { offerId: string; author: string; nftContract: string } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  if (keys.length < 5) return null;
  const offerIdLow = BigInt(keys[1]);
  const offerIdHigh = BigInt(keys[2]);
  return {
    offerId: ((offerIdHigh << 128n) | offerIdLow).toString(),
    author: normalizeAddress("STARKNET", keys[3]),
    nftContract: normalizeAddress("STARKNET", keys[4]),
  };
}

/** keys = [selector, offer_id.low, offer_id.high]; data = [open, updated_at]. */
export function decodeOfferStatusUpdatedEvent(
  event: RawStarknetEvent,
): { offerId: string; open: boolean } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  const data = event.data;
  if (keys.length < 3 || !data || data.length < 1) return null;
  const offerIdLow = BigInt(keys[1]);
  const offerIdHigh = BigInt(keys[2]);
  return {
    offerId: ((offerIdHigh << 128n) | offerIdLow).toString(),
    open: BigInt(data[0]) !== 0n,
  };
}

/**
 * Event key layout:
 *   keys[0] = selector("BidPlaced")
 *   keys[1] = offer_id.low
 *   keys[2] = offer_id.high
 *   keys[3] = sponsor (ContractAddress)
 * Event data: amount, bid_at.
 */
export function decodeBidPlacedEvent(
  event: RawStarknetEvent,
): { offerId: string; sponsor: string } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  if (keys.length < 4) return null;
  const offerIdLow = BigInt(keys[1]);
  const offerIdHigh = BigInt(keys[2]);
  return {
    offerId: ((offerIdHigh << 128n) | offerIdLow).toString(),
    sponsor: normalizeAddress("STARKNET", keys[3]),
  };
}

/** keys = [selector, offer_id.low, offer_id.high, sponsor]. No data fields needed. */
export function decodeBidRetractedEvent(
  event: RawStarknetEvent,
): { offerId: string; sponsor: string } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  if (keys.length < 4) return null;
  const offerIdLow = BigInt(keys[1]);
  const offerIdHigh = BigInt(keys[2]);
  return {
    offerId: ((offerIdHigh << 128n) | offerIdLow).toString(),
    sponsor: normalizeAddress("STARKNET", keys[3]),
  };
}

/**
 * Event key layout:
 *   keys[0] = selector("SponsorshipAccepted")
 *   keys[1] = offer_id.low
 *   keys[2] = offer_id.high
 *   keys[3] = license_id.low
 *   keys[4] = license_id.high
 *   keys[5] = sponsor (ContractAddress)
 * Event data: author, amount, expires_at — NOT parsed from event data;
 * resolveLicense() re-reads the full struct via get_license() instead.
 */
export function decodeSponsorshipAcceptedEvent(
  event: RawStarknetEvent,
): { offerId: string; licenseId: string; sponsor: string } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  if (keys.length < 6) return null;
  const offerIdLow = BigInt(keys[1]);
  const offerIdHigh = BigInt(keys[2]);
  const licenseIdLow = BigInt(keys[3]);
  const licenseIdHigh = BigInt(keys[4]);
  return {
    offerId: ((offerIdHigh << 128n) | offerIdLow).toString(),
    licenseId: ((licenseIdHigh << 128n) | licenseIdLow).toString(),
    sponsor: normalizeAddress("STARKNET", keys[5]),
  };
}

/** keys = [selector, license_id.low, license_id.high, from, to]. No data fields needed. */
export function decodeLicenseTransferredEvent(
  event: RawStarknetEvent,
): { licenseId: string; to: string } | null {
  const keys = event.keys.map((k) => num.toHex(k));
  if (keys.length < 5) return null;
  const licenseIdLow = BigInt(keys[1]);
  const licenseIdHigh = BigInt(keys[2]);
  return {
    licenseId: ((licenseIdHigh << 128n) | licenseIdLow).toString(),
    to: normalizeAddress("STARKNET", keys[4]),
  };
}

// ── Cairo ByteArray decode (raw felts from provider.callContract) ─────────────
// Same canonical pattern as collectionCreated.ts's decodeByteArray — copied
// rather than imported since neither file exports it as a shared utility yet.
// Raw layout: [data_len, ...31-byte chunks, pending_word, pending_word_len].
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

export interface ResolvedOffer {
  author: string;
  nftContract: string;
  tokenId: string;
  minAmount: string;
  duration: bigint;
  paymentToken: string;
  licenseTermsUri: string;
  transferable: boolean;
  specificSponsor: string | null;
  open: boolean;
}

/**
 * Resolve an OfferCreated/OfferStatusUpdated event by calling get_offer() —
 * mirrors resolveCollectionCreated's approach (a view call instead of
 * decoding event data), since license_terms_uri is a variable-length
 * ByteArray sandwiched between fixed fields.
 *
 * ⚠️ Field-offset layout below (Serde struct-field order from
 * IP-Sponsorhip/src/types.cairo) has NOT been verified against a live
 * emitted response — no contract is deployed yet. Verify offsets against a
 * real get_offer() call before trusting in production; this is the same
 * "verify after deploy" caveat this backend already carries for other
 * decoders (see the ByteArray decoding note in CLAUDE.md).
 */
export async function resolveOffer(offerId: string): Promise<ResolvedOffer | null> {
  try {
    const id = BigInt(offerId);
    const low = id & ((1n << 128n) - 1n);
    const high = id >> 128n;
    const raw = (await callRpc((provider) => provider.callContract({
      contractAddress: STARKNET_IP_SPONSORSHIP_CONTRACT,
      entrypoint: "get_offer",
      calldata: [num.toHex(low), num.toHex(high)],
    }))) as unknown as string[];

    if (!raw || raw.length < 10) {
      log.warn({ offerId }, "get_offer returned an unexpectedly short response");
      return null;
    }

    let i = 0;
    const author = normalizeAddress("STARKNET", raw[i++]);
    const nftContract = normalizeAddress("STARKNET", raw[i++]);
    const tokenId = ((BigInt(raw[i + 1]) << 128n) | BigInt(raw[i])).toString();
    i += 2;
    const minAmount = ((BigInt(raw[i + 1]) << 128n) | BigInt(raw[i])).toString();
    i += 2;
    const duration = BigInt(raw[i++]);
    const paymentToken = normalizeAddress("STARKNET", raw[i++]);
    const { value: licenseTermsUri, nextOffset } = decodeByteArray(raw, i);
    i = nextOffset;
    const transferable = BigInt(raw[i++]) !== 0n;
    const specificSponsorVariant = BigInt(raw[i++]);
    const specificSponsor = specificSponsorVariant === 0n ? normalizeAddress("STARKNET", raw[i++]) : null;
    const open = BigInt(raw[i++]) !== 0n;

    return { author, nftContract, tokenId, minAmount, duration, paymentToken, licenseTermsUri, transferable, specificSponsor, open };
  } catch (err) {
    log.error({ err, offerId }, "resolveOffer failed");
    return null;
  }
}

export interface ResolvedLicense {
  author: string;
  sponsor: string;
  nftContract: string;
  tokenId: string;
  amountPaid: string;
  expiresAt: bigint;
  transferable: boolean;
  licenseTermsUri: string;
}

/** Same "verify after deploy" caveat as resolveOffer() above. */
export async function resolveLicense(licenseId: string): Promise<ResolvedLicense | null> {
  try {
    const id = BigInt(licenseId);
    const low = id & ((1n << 128n) - 1n);
    const high = id >> 128n;
    const raw = (await callRpc((provider) => provider.callContract({
      contractAddress: STARKNET_IP_SPONSORSHIP_CONTRACT,
      entrypoint: "get_license",
      calldata: [num.toHex(low), num.toHex(high)],
    }))) as unknown as string[];

    if (!raw || raw.length < 8) {
      log.warn({ licenseId }, "get_license returned an unexpectedly short response");
      return null;
    }

    let i = 0;
    const author = normalizeAddress("STARKNET", raw[i++]);
    const sponsor = normalizeAddress("STARKNET", raw[i++]);
    const nftContract = normalizeAddress("STARKNET", raw[i++]);
    const tokenId = ((BigInt(raw[i + 1]) << 128n) | BigInt(raw[i])).toString();
    i += 2;
    const amountPaid = ((BigInt(raw[i + 1]) << 128n) | BigInt(raw[i])).toString();
    i += 2;
    const expiresAt = BigInt(raw[i++]);
    const transferable = BigInt(raw[i++]) !== 0n;
    const { value: licenseTermsUri } = decodeByteArray(raw, i);

    return { author, sponsor, nftContract, tokenId, amountPaid, expiresAt, transferable, licenseTermsUri };
  } catch (err) {
    log.error({ err, licenseId }, "resolveLicense failed");
    return null;
  }
}

async function upsertOffer(offerId: string, offer: ResolvedOffer): Promise<void> {
  await prisma.sponsorshipOffer.upsert({
    where: { chain_sponsorshipContract_offerId: { chain: "STARKNET", sponsorshipContract: STARKNET_IP_SPONSORSHIP_CONTRACT, offerId } },
    create: {
      chain: "STARKNET",
      sponsorshipContract: STARKNET_IP_SPONSORSHIP_CONTRACT,
      offerId,
      author: offer.author,
      nftContract: offer.nftContract,
      tokenId: offer.tokenId,
      minAmount: offer.minAmount,
      duration: offer.duration,
      paymentToken: offer.paymentToken,
      licenseTermsUri: offer.licenseTermsUri,
      transferable: offer.transferable,
      specificSponsor: offer.specificSponsor,
      open: offer.open,
    },
    update: { open: offer.open },
  });
}

export async function handleOfferCreated(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeOfferCreatedEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "OfferCreated: unexpected key length, skipping");
    return;
  }
  const offer = await resolveOffer(decoded.offerId);
  if (!offer) return;
  await upsertOffer(decoded.offerId, offer);
  log.info({ offerId: decoded.offerId }, "Sponsorship offer indexed");
}

export async function handleOfferStatusUpdated(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeOfferStatusUpdatedEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "OfferStatusUpdated: unexpected key/data length, skipping");
    return;
  }
  await prisma.sponsorshipOffer.updateMany({
    where: { chain: "STARKNET", sponsorshipContract: STARKNET_IP_SPONSORSHIP_CONTRACT, offerId: decoded.offerId },
    data: { open: decoded.open },
  });
}

export async function handleBidPlaced(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeBidPlacedEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "BidPlaced: unexpected key length, skipping");
    return;
  }
  const amount = (await callRpc((provider) => provider.callContract({
    contractAddress: STARKNET_IP_SPONSORSHIP_CONTRACT,
    entrypoint: "get_bid",
    calldata: [
      num.toHex(BigInt(decoded.offerId) & ((1n << 128n) - 1n)),
      num.toHex(BigInt(decoded.offerId) >> 128n),
      decoded.sponsor,
    ],
  }))) as unknown as string[];
  const amountStr = amount && amount.length >= 2 ? ((BigInt(amount[1]) << 128n) | BigInt(amount[0])).toString() : "0";

  await prisma.sponsorshipBid.upsert({
    where: {
      chain_sponsorshipContract_offerId_sponsor: {
        chain: "STARKNET",
        sponsorshipContract: STARKNET_IP_SPONSORSHIP_CONTRACT,
        offerId: decoded.offerId,
        sponsor: decoded.sponsor,
      },
    },
    create: {
      chain: "STARKNET",
      sponsorshipContract: STARKNET_IP_SPONSORSHIP_CONTRACT,
      offerId: decoded.offerId,
      sponsor: decoded.sponsor,
      amount: amountStr,
      status: "ACTIVE",
    },
    update: { amount: amountStr, status: "ACTIVE" },
  });
}

export async function handleBidRetracted(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeBidRetractedEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "BidRetracted: unexpected key length, skipping");
    return;
  }
  await prisma.sponsorshipBid.updateMany({
    where: {
      chain: "STARKNET",
      sponsorshipContract: STARKNET_IP_SPONSORSHIP_CONTRACT,
      offerId: decoded.offerId,
      sponsor: decoded.sponsor,
    },
    data: { status: "RETRACTED" },
  });
}

export async function handleSponsorshipAccepted(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeSponsorshipAcceptedEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "SponsorshipAccepted: unexpected key length, skipping");
    return;
  }
  const license = await resolveLicense(decoded.licenseId);
  if (!license) return;

  await prisma.$transaction([
    prisma.sponsorshipOffer.updateMany({
      where: { chain: "STARKNET", sponsorshipContract: STARKNET_IP_SPONSORSHIP_CONTRACT, offerId: decoded.offerId },
      data: { open: false },
    }),
    prisma.sponsorshipBid.updateMany({
      where: {
        chain: "STARKNET",
        sponsorshipContract: STARKNET_IP_SPONSORSHIP_CONTRACT,
        offerId: decoded.offerId,
        sponsor: decoded.sponsor,
      },
      data: { status: "ACCEPTED" },
    }),
    prisma.sponsorshipLicense.upsert({
      where: {
        chain_sponsorshipContract_licenseId: {
          chain: "STARKNET",
          sponsorshipContract: STARKNET_IP_SPONSORSHIP_CONTRACT,
          licenseId: decoded.licenseId,
        },
      },
      create: {
        chain: "STARKNET",
        sponsorshipContract: STARKNET_IP_SPONSORSHIP_CONTRACT,
        licenseId: decoded.licenseId,
        offerId: decoded.offerId,
        sponsor: license.sponsor,
        transferable: license.transferable,
        expiresAt: license.expiresAt,
      },
      update: {},
    }),
  ]);

  log.info({ offerId: decoded.offerId, licenseId: decoded.licenseId }, "Sponsorship license indexed");
}

export async function handleLicenseTransferred(event: RawStarknetEvent): Promise<void> {
  const decoded = decodeLicenseTransferredEvent(event);
  if (!decoded) {
    log.warn({ txHash: event.transaction_hash }, "LicenseTransferred: unexpected key length, skipping");
    return;
  }
  await prisma.sponsorshipLicense.updateMany({
    where: { chain: "STARKNET", sponsorshipContract: STARKNET_IP_SPONSORSHIP_CONTRACT, licenseId: decoded.licenseId },
    data: { sponsor: decoded.to },
  });
}

/** Dispatch a raw IPSponsorship event to its handler by selector (keys[0]). */
export async function handleSponsorshipEvent(event: RawStarknetEvent): Promise<void> {
  const selector = num.toHex(event.keys[0] ?? "0x0");
  switch (selector) {
    case num.toHex(OFFER_CREATED_SELECTOR):
      return handleOfferCreated(event);
    case num.toHex(OFFER_STATUS_UPDATED_SELECTOR):
      return handleOfferStatusUpdated(event);
    case num.toHex(BID_PLACED_SELECTOR):
      return handleBidPlaced(event);
    case num.toHex(BID_RETRACTED_SELECTOR):
      return handleBidRetracted(event);
    case num.toHex(SPONSORSHIP_ACCEPTED_SELECTOR):
      return handleSponsorshipAccepted(event);
    case num.toHex(LICENSE_TRANSFERRED_SELECTOR):
      return handleLicenseTransferred(event);
    default:
      log.warn({ selector }, "handleSponsorshipEvent: unrecognized selector, skipping");
  }
}
