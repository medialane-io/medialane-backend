import { describe, expect, test } from "bun:test";
import { resolveFeeConfig } from "@medialane/sdk";
import { platformFeeCalls } from "./fee.js";
import { fulfillFeeCalls } from "./marketplace.js";
import { buildAcceptSponsorshipBidIntent, buildAcceptSponsorshipProposalIntent } from "./sponsorship.js";

const TOKEN = "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8";
const FUND = "0x0123";
const cfg = resolveFeeConfig({ enabled: true, fundAddress: FUND, marketplaceBps: 100, launchpadBps: 100, sponsorshipBps: 100 });

describe("platformFeeCalls", () => {
  test("adds one transfer of 1% to the fund for a Medialane app", () => {
    expect(platformFeeCalls("MEDIALANE_IO", "marketplace", TOKEN, 1_000_000n, cfg)).toEqual([
      { contractAddress: TOKEN, entrypoint: "transfer", calldata: [FUND, "10000", "0"] },
    ]);
  });

  test("adds nothing for a partner app or the default app", () => {
    expect(platformFeeCalls("PARTNER_APP", "marketplace", TOKEN, 1_000_000n, cfg)).toEqual([]);
    expect(platformFeeCalls("MEDIALANE_API", "marketplace", TOKEN, 1_000_000n, cfg)).toEqual([]);
  });

  test("adds nothing while no fund address is configured", () => {
    const off = resolveFeeConfig({ enabled: true });
    expect(platformFeeCalls("MEDIALANE_STARKNET", "launchpad", TOKEN, 1_000_000n, off)).toEqual([]);
  });

  test("adds nothing when the fee rounds to zero", () => {
    expect(platformFeeCalls("MEDIALANE_PORTAL", "sponsorship", TOKEN, 99n, cfg)).toEqual([]);
  });
});

describe("sponsorship accept intents carry the fee", () => {
  const read = {
    offer: async () => ({ paymentToken: TOKEN }),
    bid: async () => 5_000_000n,
    proposal: async () => ({ amount: 2_000_000n, paymentToken: TOKEN }),
  };

  test("accept bid appends a fee on the bid amount for a Medialane app", async () => {
    const built = await buildAcceptSponsorshipBidIntent({ author: "0x1", offerId: "7", sponsor: "0x2" }, { appId: "MEDIALANE_IO" }, read, cfg);
    expect(built.calls).toHaveLength(2);
    expect(built.calls[1]).toEqual({ contractAddress: TOKEN, entrypoint: "transfer", calldata: [FUND, "50000", "0"] });
  });

  test("accept proposal appends a fee on the proposal amount", async () => {
    const built = await buildAcceptSponsorshipProposalIntent({ owner: "0x1", proposalId: "3" }, { appId: "MEDIALANE_STARKNET" }, read, cfg);
    expect(built.calls[1]).toEqual({ contractAddress: TOKEN, entrypoint: "transfer", calldata: [FUND, "20000", "0"] });
  });

  test("a partner app gets only the protocol call", async () => {
    const built = await buildAcceptSponsorshipBidIntent({ author: "0x1", offerId: "7", sponsor: "0x2" }, { appId: "PARTNER" }, read, cfg);
    expect(built.calls).toHaveLength(1);
  });
});

describe("purchase intents carry the marketplace fee", () => {
  const listing = { offerItemType: "ERC1155", considerationItemType: "ERC20", considerationToken: TOKEN, considerationStartAmount: "1000000" };

  test("a listing purchase pays 1% of price times quantity", () => {
    expect(fulfillFeeCalls(listing, 3n, { appId: "MEDIALANE_IO" }, cfg)).toEqual([
      { contractAddress: TOKEN, entrypoint: "transfer", calldata: [FUND, "30000", "0"] },
    ]);
  });

  test("accepting an offer pays no fee", () => {
    const offer = { offerItemType: "ERC20", considerationItemType: "ERC721", considerationToken: "0x9", considerationStartAmount: "1" };
    expect(fulfillFeeCalls(offer, 1n, { appId: "MEDIALANE_IO" }, cfg)).toEqual([]);
  });

  test("an order missing from the index pays no fee", () => {
    expect(fulfillFeeCalls(null, 1n, { appId: "MEDIALANE_IO" }, cfg)).toEqual([]);
  });
});

describe("no fee means no chain reads", () => {
  const explode = {
    offer: async () => { throw new Error("read offer"); },
    bid: async () => { throw new Error("read bid"); },
    proposal: async () => { throw new Error("read proposal"); },
  };

  test("a partner app's accept intents never read the contract", async () => {
    const bid = await buildAcceptSponsorshipBidIntent({ author: "0x1", offerId: "7", sponsor: "0x2" }, { appId: "PARTNER" }, explode, cfg);
    const proposal = await buildAcceptSponsorshipProposalIntent({ owner: "0x1", proposalId: "3" }, { appId: "PARTNER" }, explode, cfg);
    expect([bid.calls.length, proposal.calls.length]).toEqual([1, 1]);
  });

  test("with no fund address configured, Medialane apps don't read the contract either", async () => {
    const off = resolveFeeConfig({ enabled: true });
    const bid = await buildAcceptSponsorshipBidIntent({ author: "0x1", offerId: "7", sponsor: "0x2" }, { appId: "MEDIALANE_IO" }, explode, off);
    expect(bid.calls).toHaveLength(1);
  });
});
