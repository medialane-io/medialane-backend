// IP-Sponsorship intents. None of these need SNIP-12 signing (no
// order-signing scheme on this contract; msg.sender is the account executing
// the call) — every builder below returns fully-populated calls, same shape
// as buildMintIntent. Parameter order/types come straight from the SDK's
// SponsorshipService (src/starknet/services/sponsorship.ts) — the source of
// truth.
import { cairo, Contract, CairoOption, CairoOptionVariant } from "starknet";
import { normalizeAddress, createProvider } from "../../utils/starknet.js";
import { STARKNET_IP_SPONSORSHIP_CONTRACT } from "../../config/constants.js";
import { IPSponsorshipABI } from "@medialane/sdk/starknet";
import type {
  CreateSponsorshipOfferIntentBody,
  SetSponsorshipOfferOpenIntentBody,
  PlaceSponsorshipBidIntentBody,
  RetractSponsorshipBidIntentBody,
  AcceptSponsorshipBidIntentBody,
  CreateSponsorshipProposalIntentBody,
  WithdrawSponsorshipProposalIntentBody,
  AcceptSponsorshipProposalIntentBody,
  RejectSponsorshipProposalIntentBody,
} from "../../types/api.js";

function sponsorshipContract(): Contract {
  return new Contract(IPSponsorshipABI as never, STARKNET_IP_SPONSORSHIP_CONTRACT, createProvider() as never);
}

/** Build a CREATE_SPONSORSHIP_OFFER intent — no SNIP-12 signing required. */
export async function buildCreateSponsorshipOfferIntent(body: CreateSponsorshipOfferIntentBody) {
  const specificSponsor = body.specificSponsor
    ? new CairoOption(CairoOptionVariant.Some, normalizeAddress("STARKNET", body.specificSponsor))
    : new CairoOption(CairoOptionVariant.None);

  const call = sponsorshipContract().populate("create_offer", [
    normalizeAddress("STARKNET", body.nftContract),
    cairo.uint256(body.tokenId),
    cairo.uint256(body.minAmount),
    body.duration,
    normalizeAddress("STARKNET", body.paymentToken),
    body.licenseTermsUri,
    body.transferable,
    cairo.uint256(body.royaltyBps),
    specificSponsor,
  ]);
  return { calls: [call] };
}

/** Build a SET_SPONSORSHIP_OFFER_OPEN intent — toggles bid/acceptance eligibility. Reversible. */
export async function buildSetSponsorshipOfferOpenIntent(body: SetSponsorshipOfferOpenIntentBody) {
  const call = sponsorshipContract().populate("set_offer_open", [
    cairo.uint256(body.offerId),
    body.open,
  ]);
  return { calls: [call] };
}

/**
 * Build a PLACE_SPONSORSHIP_BID intent — a bid is a signal plus an open ERC-20
 * allowance; no tokens move until accept_bid. Bundles the approve, matching
 * the SDK's SponsorshipService.placeBid.
 */
export async function buildPlaceSponsorshipBidIntent(body: PlaceSponsorshipBidIntentBody) {
  const amount = cairo.uint256(body.amount);
  const approveCall = {
    contractAddress: normalizeAddress("STARKNET", body.paymentToken),
    entrypoint: "approve",
    calldata: [STARKNET_IP_SPONSORSHIP_CONTRACT, amount.low.toString(), amount.high.toString()],
  };
  const bidCall = sponsorshipContract().populate("place_bid", [
    cairo.uint256(body.offerId),
    amount,
  ]);
  return { calls: [approveCall, bidCall] };
}

/** Build a RETRACT_SPONSORSHIP_BID intent — sponsor-only, withdraws a standing bid. */
export async function buildRetractSponsorshipBidIntent(body: RetractSponsorshipBidIntentBody) {
  const call = sponsorshipContract().populate("retract_bid", [cairo.uint256(body.offerId)]);
  return { calls: [call] };
}

/**
 * Build an ACCEPT_SPONSORSHIP_BID intent — author-only. Re-verifies IP
 * ownership, settles the sponsor's payment (allowance pull, no escrow), and
 * mints the license atomically, all on-chain. No fee is bundled here — the
 * platform fee is the calling app's responsibility (bundled atomically for
 * starknet's direct signer, charged as a separate post-confirmation
 * transaction for io's non-atomic ChipiPay account), same precedent as
 * buildFulfillOrderIntent.
 */
export async function buildAcceptSponsorshipBidIntent(body: AcceptSponsorshipBidIntentBody) {
  const call = sponsorshipContract().populate("accept_bid", [
    cairo.uint256(body.offerId),
    normalizeAddress("STARKNET", body.sponsor),
  ]);
  return { calls: [call] };
}

/** Build a CREATE_SPONSORSHIP_PROPOSAL intent — sponsor-initiated, symmetric counterpart to an offer. */
export async function buildCreateSponsorshipProposalIntent(body: CreateSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("propose_sponsorship", [
    normalizeAddress("STARKNET", body.nftContract),
    cairo.uint256(body.tokenId),
    cairo.uint256(body.amount),
    body.duration,
    body.validUntil ?? 0,
    normalizeAddress("STARKNET", body.paymentToken),
    body.licenseTermsUri,
    body.transferable,
    cairo.uint256(body.royaltyBps),
  ]);
  return { calls: [call] };
}

/** Build a WITHDRAW_SPONSORSHIP_PROPOSAL intent — proposer-only. */
export async function buildWithdrawSponsorshipProposalIntent(body: WithdrawSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("withdraw_proposal", [cairo.uint256(body.proposalId)]);
  return { calls: [call] };
}

/**
 * Build an ACCEPT_SPONSORSHIP_PROPOSAL intent — asset-owner-only (re-verified
 * on-chain; a proposal binds to the asset, not a person). Settles payment and
 * mints the license atomically, same fee precedent as buildAcceptSponsorshipBidIntent.
 */
export async function buildAcceptSponsorshipProposalIntent(body: AcceptSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("accept_proposal", [cairo.uint256(body.proposalId)]);
  return { calls: [call] };
}

/** Build a REJECT_SPONSORSHIP_PROPOSAL intent — asset-owner-only. */
export async function buildRejectSponsorshipProposalIntent(body: RejectSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("reject_proposal", [cairo.uint256(body.proposalId)]);
  return { calls: [call] };
}
