import type { z } from "zod";
import type { starknet } from "@medialane/sdk/contract";

export type FulfillOrderIntentBody = z.output<typeof starknet.fulfillSchema>;
export type MintIntentBody = z.output<typeof starknet.mintSchema> & { customUri?: string };
export type CreateCollectionIntentBody = z.output<typeof starknet.createCollectionSchema>;
export type CreateTierIntentBody = Omit<z.output<typeof starknet.createTierSchema>, "service"> & { service: string };
export type CreateCoinIntentBody = z.output<typeof starknet.createCoinSchema>;
export type LaunchCoinIntentBody = z.output<typeof starknet.launchCoinSchema>;
export type CreateSponsorshipOfferIntentBody = z.output<typeof starknet.sponsorshipOfferSchema>;
export type SetSponsorshipOfferOpenIntentBody = z.output<typeof starknet.sponsorshipOfferOpenSchema>;
export type PlaceSponsorshipBidIntentBody = z.output<typeof starknet.sponsorshipBidSchema>;
export type RetractSponsorshipBidIntentBody = z.output<typeof starknet.sponsorshipBidRetractSchema>;
export type AcceptSponsorshipBidIntentBody = z.output<typeof starknet.sponsorshipBidAcceptSchema>;
export type CreateSponsorshipProposalIntentBody = z.output<typeof starknet.sponsorshipProposalSchema>;
export type WithdrawSponsorshipProposalIntentBody = z.output<typeof starknet.sponsorshipProposalWithdrawSchema>;
export type AcceptSponsorshipProposalIntentBody = z.output<typeof starknet.sponsorshipProposalAcceptSchema>;
export type RejectSponsorshipProposalIntentBody = z.output<typeof starknet.sponsorshipProposalRejectSchema>;
