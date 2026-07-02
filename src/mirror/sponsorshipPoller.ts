import { num } from "starknet";
import { normalizeAddress } from "../utils/starknet.js";
import type { RawStarknetEvent } from "../types/starknet.js";

/**
 * Handle events from the IPSponsorship contract. Unlike Tickets/Club, this
 * is neither a Collection factory nor a per-instance ERC-721 — IPSponsorship
 * mints nothing itself, so these decoders feed SponsorshipOffer/Bid/License
 * tables directly (see prisma/schema.prisma), not upsertCollectionFromFactory.
 * Runs on its own decoupled poll cadence + cursor, same shape as the Creator
 * Coin factory poller (src/mirror/ — pollCreatorCoinFactoryEvents), since it
 * isn't visited by the main Collection-factory mirror loop.
 */

/**
 * Event key layout (IPSponsorship, Cairo 2.x, #[key] fields):
 *   keys[0] = selector("OfferCreated")
 *   keys[1] = offer_id.low   (u256 split)
 *   keys[2] = offer_id.high
 *   keys[3] = author (ContractAddress)
 *   keys[4] = nft_contract (ContractAddress)
 * Event data: token_id, min_amount, duration, payment_token,
 *   license_terms_uri, transferable, specific_sponsor, created_at (not
 *   parsed here — the full poll-loop write path parses these once wired).
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

/**
 * Event key layout:
 *   keys[0] = selector("SponsorshipAccepted")
 *   keys[1] = offer_id.low
 *   keys[2] = offer_id.high
 *   keys[3] = license_id.low
 *   keys[4] = license_id.high
 *   keys[5] = sponsor (ContractAddress)
 * Event data: author, amount, expires_at.
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
