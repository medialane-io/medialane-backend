import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OnChainOrderDetails } from "../../types/marketplace.js";

const CREATOR = "0x" + "a".repeat(64);
const REQUESTER = "0x" + "b".repeat(64);
const STRANGER = "0x" + "c".repeat(64);
const ORIGINAL = "0x" + "1".repeat(64);
const REMIX = "0x" + "2".repeat(64);
const ORDER_HASH = "0x" + "9".repeat(64);

const offerRow = {
  id: "offer-1",
  status: "PENDING",
  originalContract: ORIGINAL,
  originalTokenId: "7",
  creatorAddress: CREATOR,
  requesterAddress: REQUESTER,
  message: "private note",
  proposedPrice: "1000",
  proposedCurrency: "0x" + "d".repeat(64),
  licenseType: "CC BY",
  commercial: false,
  derivatives: true,
  royaltyPct: null,
  approvedCollection: null,
  remixContract: null,
  remixTokenId: null,
  orderHash: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const chain = {
  owns: true,
  order: {
    offerer: CREATOR,
    offerItemType: "ERC721",
    offerToken: REMIX,
    offerIdentifier: "5",
  } as Partial<OnChainOrderDetails>,
  calls: 0,
};

const update = mock(async (args: { data: Record<string, unknown> }) => ({ ...offerRow, ...args.data }));

mock.module("../../db/client.js", () => ({
  default: {
    remixOffer: { findUnique: mock(async () => offerRow), update },
    identity: { findUnique: mock(async () => null) },
  },
}));

mock.module("./remix-offers.chain.js", () => ({
  remixLinkDeps: {
    collectionStandard: async () => "ERC721",
    ownsToken: async () => {
      chain.calls++;
      return chain.owns;
    },
    orderDetails: async () => ({ ...chain.order }),
  },
}));

const { default: remixOffers } = await import("./remix-offers.js");
const { issueToken } = await import("../../utils/siwsToken.js");

const as = (wallet: string) => ({ authorization: `Bearer ${issueToken("STARKNET", wallet)}` });

function confirm(wallet: string, body: Record<string, unknown> = {}) {
  return remixOffers.request("/offer-1/confirm?chain=STARKNET", {
    method: "POST",
    headers: { ...as(wallet), "content-type": "application/json" },
    body: JSON.stringify({
      remixContract: REMIX,
      remixTokenId: "5",
      approvedCollection: REMIX,
      orderHash: ORDER_HASH,
      ...body,
    }),
  });
}

beforeEach(() => {
  chain.owns = true;
  chain.order = { offerer: CREATOR, offerItemType: "ERC721", offerToken: REMIX, offerIdentifier: "5" };
  chain.calls = 0;
  update.mockClear();
});

describe("reading an offer", () => {
  test("an anonymous caller gets no price and no message", async () => {
    const res = await remixOffers.request("/offer-1?chain=STARKNET");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.message).toBeUndefined();
    expect(data.price).toBeUndefined();
    expect(data.status).toBe("PENDING");
  });

  test("a stranger gets no price and no message", async () => {
    const res = await remixOffers.request("/offer-1?chain=STARKNET", { headers: as(STRANGER) });
    const { data } = await res.json();
    expect(data.message).toBeUndefined();
    expect(data.price).toBeUndefined();
  });

  test("the requester sees both", async () => {
    const res = await remixOffers.request("/offer-1?chain=STARKNET", { headers: as(REQUESTER) });
    const { data } = await res.json();
    expect(data.message).toBe("private note");
    expect(data.price).toBeDefined();
  });

  test("the creator sees both", async () => {
    const res = await remixOffers.request("/offer-1?chain=STARKNET", { headers: as(CREATOR) });
    const { data } = await res.json();
    expect(data.message).toBe("private note");
    expect(data.price).toBeDefined();
  });
});

describe("confirming an offer", () => {
  test("saves a link the chain backs", async () => {
    const res = await confirm(CREATOR);
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0].data).toEqual({
      status: "APPROVED",
      remixContract: REMIX,
      remixTokenId: "5",
      approvedCollection: REMIX,
      orderHash: ORDER_HASH,
    });
  });

  test("saves nothing when the creator does not hold the token", async () => {
    chain.owns = false;
    const res = await confirm(CREATOR);
    expect(res.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  test("saves nothing when the listing belongs to someone else", async () => {
    chain.order = { ...chain.order, offerer: STRANGER };
    const res = await confirm(CREATOR);
    expect(res.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  test("saves nothing when the listing is for another token", async () => {
    chain.order = { ...chain.order, offerIdentifier: "6" };
    const res = await confirm(CREATOR);
    expect(res.status).toBe(422);
    expect(update).not.toHaveBeenCalled();
  });

  test("only the creator may confirm, and the chain is not even read for anyone else", async () => {
    const res = await confirm(REQUESTER);
    expect(res.status).toBe(403);
    expect(chain.calls).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
});
