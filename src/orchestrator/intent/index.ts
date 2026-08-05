// Intent builders — one file per domain, re-exported here as the single
// import surface (`orchestrator/intent/index.js`) the routes layer and tests
// use. Split 2026-08-05 once sponsorship + factory-family + coin intents had
// grown this into one 970-line file; each domain is still small on its own:
//   shared.ts       — counter/royalty RPC reads, buildOrderParams, small utils
//   marketplace.ts  — listing / offer / fulfill / cancel / counter-offer
//   collection.ts   — mint / create-collection / create-tier (registry + factory-family)
//   coin.ts         — create-coin / launch-coin
//   sponsorship.ts  — the 9 ip-sponsorship intents
export { buildOrderParams } from "./shared.js";
export {
  buildCreateListingIntent,
  buildMakeOfferIntent,
  buildFulfillOrderIntent,
  buildCancelOrderIntent,
  buildCounterOfferIntent,
} from "./marketplace.js";
export {
  FACTORY_FAMILY_SERVICE_IDS,
  TIER_SERVICE_IDS,
  COLLECTION_SERVICE_IDS,
  buildMintIntent,
  buildCreateCollectionIntent,
  buildCreateTierIntent,
} from "./collection.js";
export { buildCreateCoinIntent, buildLaunchCoinIntent } from "./coin.js";
export {
  buildCreateSponsorshipOfferIntent,
  buildSetSponsorshipOfferOpenIntent,
  buildPlaceSponsorshipBidIntent,
  buildRetractSponsorshipBidIntent,
  buildAcceptSponsorshipBidIntent,
  buildCreateSponsorshipProposalIntent,
  buildWithdrawSponsorshipProposalIntent,
  buildAcceptSponsorshipProposalIntent,
  buildRejectSponsorshipProposalIntent,
} from "./sponsorship.js";
