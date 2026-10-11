

import { cairo, Contract, CairoOption, CairoOptionVariant } from "starknet";
import { normalizeAddress, createProvider } from "../../utils/starknet.js";
import { STARKNET_IP_SPONSORSHIP_CONTRACT } from "../../config/constants.js";
import { IPSponsorshipABI } from "@medialane/sdk/starknet";
import type { ResolvedFeeConfig } from "@medialane/sdk";
import { feeApplies, platformFeeCalls, platformFeeConfig, type IntentBuildContext } from "./fee.js";
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

export interface SponsorshipReader {
  offer(offerId: string): Promise<{ paymentToken: string }>;
  bid(offerId: string, sponsor: string): Promise<bigint>;
  proposal(proposalId: string): Promise<{ amount: bigint; paymentToken: string }>;
}

const hexAddress = (v: bigint | string) => (typeof v === "bigint" ? "0x" + v.toString(16) : String(v));

export const chainSponsorshipReader: SponsorshipReader = {
  async offer(offerId) {
    const o = (await sponsorshipContract().call("get_offer", [cairo.uint256(offerId)])) as { payment_token: bigint | string };
    return { paymentToken: normalizeAddress("STARKNET", hexAddress(o.payment_token)) };
  },
  async bid(offerId, sponsor) {
    return BigInt((await sponsorshipContract().call("get_bid", [cairo.uint256(offerId), normalizeAddress("STARKNET", sponsor)])) as bigint);
  },
  async proposal(proposalId) {
    const p = (await sponsorshipContract().call("get_proposal", [cairo.uint256(proposalId)])) as { amount: bigint; payment_token: bigint | string };
    return { amount: BigInt(p.amount), paymentToken: normalizeAddress("STARKNET", hexAddress(p.payment_token)) };
  },
};

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

export async function buildAcceptSponsorshipBidIntent(
  body: AcceptSponsorshipBidIntentBody,
  ctx: IntentBuildContext = { appId: "" },
  read: SponsorshipReader = chainSponsorshipReader,
  cfg: ResolvedFeeConfig = platformFeeConfig,
) {
  const call = sponsorshipContract().populate("accept_bid", [
    cairo.uint256(body.offerId),
    normalizeAddress("STARKNET", body.sponsor),
  ]);
  if (!feeApplies(ctx.appId, cfg)) return { calls: [call] };
  const [offer, amount] = await Promise.all([read.offer(body.offerId), read.bid(body.offerId, body.sponsor)]);
  return { calls: [call, ...platformFeeCalls(ctx.appId, "sponsorship", offer.paymentToken, amount, cfg)] };
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

export async function buildAcceptSponsorshipProposalIntent(
  body: AcceptSponsorshipProposalIntentBody,
  ctx: IntentBuildContext = { appId: "" },
  read: SponsorshipReader = chainSponsorshipReader,
  cfg: ResolvedFeeConfig = platformFeeConfig,
) {
  const call = sponsorshipContract().populate("accept_proposal", [cairo.uint256(body.proposalId)]);
  if (!feeApplies(ctx.appId, cfg)) return { calls: [call] };
  const proposal = await read.proposal(body.proposalId);
  return { calls: [call, ...platformFeeCalls(ctx.appId, "sponsorship", proposal.paymentToken, proposal.amount, cfg)] };
}

export async function buildRejectSponsorshipProposalIntent(body: RejectSponsorshipProposalIntentBody) {
  const call = sponsorshipContract().populate("reject_proposal", [cairo.uint256(body.proposalId)]);
  return { calls: [call] };
}
