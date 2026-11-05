

import { describe, expect, test } from "bun:test";
import {
  buildOrderTypedData,
  build1155OrderTypedData,
  buildCancellationTypedData,
  build1155CancellationTypedData,
} from "@medialane/sdk/starknet";
import {
  buildCreateSponsorshipOfferIntent,
  buildSetSponsorshipOfferOpenIntent,
  buildPlaceSponsorshipBidIntent,
  buildRetractSponsorshipBidIntent,
  buildAcceptSponsorshipBidIntent,
  buildCreateSponsorshipProposalIntent,
  buildWithdrawSponsorshipProposalIntent,
  buildAcceptSponsorshipProposalIntent,
  buildRejectSponsorshipProposalIntent,
} from "./intent/index.js";

const CHAIN_ID = "SN_MAIN";
const names = (defs: readonly { name: string }[]) => defs.map((f) => f.name);

describe("ERC-721 SNIP-12 builders use domain version 5 (2026-06-26 redeploy)", () => {
  test("buildOrderTypedData", () => {
    const td = buildOrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(td.domain.name).toBe("Medialane");
    expect(td.domain.version).toBe("5");
    expect(td.primaryType).toBe("OrderParameters");
    expect(td.types.OrderParameters).toBeDefined();
    expect(td.types.OfferItem).toBeDefined();
    expect(td.types.ConsiderationItem).toBeDefined();
  });

  test("OrderParameters carries the redesigned fields in order", () => {
    const td = buildOrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(names(td.types.OrderParameters as { name: string }[])).toEqual([
      "offerer", "marketplace", "offer", "consideration",
      "royalty_max_bps", "start_time", "end_time", "salt", "counter",
    ]);
    expect(names(td.types.OfferItem as { name: string }[])).toEqual([
      "item_type", "token", "identifier_or_criteria", "amount",
    ]);
  });

  test("buildCancellationTypedData has no nonce", () => {
    const td = buildCancellationTypedData({ order_hash: "0x1" }, CHAIN_ID);
    expect(td.domain.version).toBe("5");
    expect(td.primaryType).toBe("OrderCancellation");
    expect(names(td.types.OrderCancellation as { name: string }[])).toEqual([
      "order_hash", "offerer",
    ]);
  });
});

describe("ERC-1155 SNIP-12 builders use domain version 4 (2026-06-26 redeploy)", () => {
  test("build1155OrderTypedData", () => {
    const td = build1155OrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(td.domain.name).toBe("Medialane");
    expect(td.domain.version).toBe("4");
    expect(td.primaryType).toBe("OrderParameters");
  });

  test("build1155CancellationTypedData", () => {
    const td = build1155CancellationTypedData({ order_hash: "0x1" }, CHAIN_ID);
    expect(td.domain.version).toBe("4");
    expect(td.primaryType).toBe("OrderCancellation");
  });
});

describe("Cross-standard sanity", () => {
  test("721 and 1155 order builders use different domain versions", () => {
    const v721 = buildOrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    const v1155 = build1155OrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(v721.domain.version).not.toBe(v1155.domain.version);
  });

  test("chainId is propagated into the domain", () => {
    const td = buildOrderTypedData({ offerer: "0x1" }, CHAIN_ID);
    expect(td.domain.chainId).toBe(CHAIN_ID);
  });
});

describe("Sponsorship intent builders — pure calldata, no signing", () => {
  test("buildCreateSponsorshipOfferIntent returns one populated create_offer call", async () => {
    const { calls } = await buildCreateSponsorshipOfferIntent({
      author: "0x1", nftContract: "0x2", tokenId: "5", minAmount: "1000000",
      duration: 86400, paymentToken: "0x3", licenseTermsUri: "ipfs://x",
      transferable: true, royaltyBps: 250,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].contractAddress).toBeDefined();
    expect(calls[0].entrypoint).toBe("create_offer");
  });

  test("buildCreateSponsorshipOfferIntent with specificSponsor still returns one call", async () => {
    const { calls } = await buildCreateSponsorshipOfferIntent({
      author: "0x1", nftContract: "0x2", tokenId: "5", minAmount: "1000000",
      duration: 86400, paymentToken: "0x3", licenseTermsUri: "ipfs://x",
      transferable: true, royaltyBps: 250, specificSponsor: "0x4",
    });
    expect(calls).toHaveLength(1);
  });

  test("buildSetSponsorshipOfferOpenIntent returns one populated set_offer_open call", async () => {
    const { calls } = await buildSetSponsorshipOfferOpenIntent({ author: "0x1", offerId: "1", open: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].entrypoint).toBe("set_offer_open");
  });

  test("buildPlaceSponsorshipBidIntent bundles approve + place_bid", async () => {
    const { calls } = await buildPlaceSponsorshipBidIntent({
      sponsor: "0x1", offerId: "1", amount: "1000000", paymentToken: "0x3",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].entrypoint).toBe("approve");
    expect(calls[1].entrypoint).toBe("place_bid");
  });

  test("buildRetractSponsorshipBidIntent returns one populated retract_bid call", async () => {
    const { calls } = await buildRetractSponsorshipBidIntent({ sponsor: "0x1", offerId: "1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].entrypoint).toBe("retract_bid");
  });

  test("buildAcceptSponsorshipBidIntent returns exactly one call — no fee bundled", async () => {
    const { calls } = await buildAcceptSponsorshipBidIntent({ author: "0x1", offerId: "1", sponsor: "0x2" });
    expect(calls).toHaveLength(1);
    expect(calls[0].entrypoint).toBe("accept_bid");
  });

  test("buildCreateSponsorshipProposalIntent returns one populated propose_sponsorship call", async () => {
    const { calls } = await buildCreateSponsorshipProposalIntent({
      proposer: "0x1", nftContract: "0x2", tokenId: "5", amount: "1000000",
      duration: 86400, paymentToken: "0x3", licenseTermsUri: "ipfs://x",
      transferable: true, royaltyBps: 250,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].entrypoint).toBe("propose_sponsorship");
  });

  test("buildCreateSponsorshipProposalIntent defaults validUntil to 0 when omitted", async () => {
    const { calls } = await buildCreateSponsorshipProposalIntent({
      proposer: "0x1", nftContract: "0x2", tokenId: "5", amount: "1000000",
      duration: 86400, paymentToken: "0x3", licenseTermsUri: "ipfs://x",
      transferable: true, royaltyBps: 250,
    });
    expect(calls).toHaveLength(1);
  });

  test("buildWithdrawSponsorshipProposalIntent returns one populated withdraw_proposal call", async () => {
    const { calls } = await buildWithdrawSponsorshipProposalIntent({ proposer: "0x1", proposalId: "1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].entrypoint).toBe("withdraw_proposal");
  });

  test("buildAcceptSponsorshipProposalIntent returns exactly one call — no fee bundled", async () => {
    const { calls } = await buildAcceptSponsorshipProposalIntent({ owner: "0x1", proposalId: "1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].entrypoint).toBe("accept_proposal");
  });

  test("buildRejectSponsorshipProposalIntent returns one populated reject_proposal call", async () => {
    const { calls } = await buildRejectSponsorshipProposalIntent({ owner: "0x1", proposalId: "1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].entrypoint).toBe("reject_proposal");
  });
});
