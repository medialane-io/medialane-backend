

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
  return new Contract({ abi: IPSponsorshipABI as never, address: STARKNET_IP_SPONSORSHIP_CONTRACT, providerOrAccount: createProvider() as never });
}

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

export async function buildSetSponsorshipOfferOpenIntent(body: SetSponsorshipOfferOpenIntentBody) {
  const call = sponsorshipContract().populate("set_offer_open", [
    cairo.uint256(body.offerId),
    body.open,
  ]);
  return { calls: [call] };
}

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

export async function buildRetractSponsorshipBidIntent(body: RetractSponsorshipBidIntentBody) {
  const call = sponsorshipContract().populate("retract_bid", [cairo.uint256(body.offerId)]);
  return { calls: [call] };
}

export async function buildAcceptSponsorshipBidIntent(body: AcceptSponsorshipBidIntentBody) {
  const call = sponsorshipContract().populate("accept_bid", [
    cairo.uint256(body.offerId),
    normalizeAddress("STARKNET", body.sponsor),
  ]);
  return { calls: [call] };
}

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

export async function buildWithdrawSponsorshipProposalIntent(body: WithdrawSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("withdraw_proposal", [cairo.uint256(body.proposalId)]);
  return { calls: [call] };
}

export async function buildAcceptSponsorshipProposalIntent(body: AcceptSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("accept_proposal", [cairo.uint256(body.proposalId)]);
  return { calls: [call] };
}

export async function buildRejectSponsorshipProposalIntent(body: RejectSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("reject_proposal", [cairo.uint256(body.proposalId)]);
  return { calls: [call] };
}
