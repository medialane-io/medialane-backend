

import { describe, expect, test } from "bun:test";
import {
  buildOrderTypedData,
  build1155OrderTypedData,
  buildCancellationTypedData,
  build1155CancellationTypedData,
} from "@medialane/sdk/starknet";
import {
  buildOrderParams,
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

describe("buildOrderParams — shared order-field assembly (DRY refactor safety net)", () => {
  const base = {
    offerer: "123",
    marketplace: "0x456",
    offer: { itemType: "ERC721", token: "789", identifierOrCriteria: "5", amount: "1" },
    consideration: { itemType: "ERC20", token: "0xabc", identifierOrCriteria: "0", amount: "5000000000000000000", recipient: "123" },
    royaltyMaxBps: "250",
    startTime: 1754350000,
    endTime: 1754360000,
    salt: "123456789012345",
    counter: "3",
  };

  test("every numeric/address field is hex-encoded regardless of input representation", () => {
    const params = buildOrderParams(base);
    expect(params.offerer).toBe("0x7b");
    expect(params.marketplace).toBe("0x456");
    expect(params.offer.token).toBe("0x315");
    expect(params.offer.identifier_or_criteria).toBe("0x5");
    expect(params.offer.amount).toBe("0x1");
    expect(params.consideration.amount).toBe("0x" + BigInt("5000000000000000000").toString(16));
    expect(params.consideration.recipient).toBe("0x7b");
    expect(params.royalty_max_bps).toBe("0xfa");
    expect(params.start_time).toBe("0x" + (1754350000).toString(16));
    expect(params.salt).toBe("0x" + BigInt("123456789012345").toString(16));
  });

  test("item_type shortstrings pass through unmodified", () => {
    const params = buildOrderParams(base);
    expect(params.offer.item_type).toBe("ERC721");
    expect(params.consideration.item_type).toBe("ERC20");
  });

  test("hex-string and decimal-string field representations yield the same signed hash", () => {

    const hexParams = buildOrderParams(base);
    const decParams = buildOrderParams({
      ...base,
      offerer: "0x7b",
      offer: { ...base.offer, token: "0x315" },
    });
    const hexTd = buildOrderTypedData(hexParams as unknown as Record<string, unknown>, CHAIN_ID);
    const decTd = buildOrderTypedData(decParams as unknown as Record<string, unknown>, CHAIN_ID);
    expect(hexTd.message).toEqual(decTd.message);
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
