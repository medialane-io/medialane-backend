import { describe, expect, test } from "bun:test";
import type { OnChainOrderDetails } from "../../types/marketplace.js";
import { isParticipant, verifyRemixLink, type RemixLinkDeps } from "./remix-offers.rules.js";

const CREATOR = "0x" + "a".repeat(64);
const REQUESTER = "0x" + "b".repeat(64);
const STRANGER = "0x" + "c".repeat(64);
const ORIGINAL = "0x" + "1".repeat(64);
const REMIX = "0x" + "2".repeat(64);
const ORDER_HASH = "0x" + "9".repeat(64);

const offer = { creatorAddress: CREATOR, requesterAddress: REQUESTER };

describe("who may see an offer's price and message", () => {
  test("the creator and the requester", () => {
    expect(isParticipant(offer, CREATOR)).toBe(true);
    expect(isParticipant(offer, REQUESTER)).toBe(true);
  });

  test("not a stranger", () => {
    expect(isParticipant(offer, STRANGER)).toBe(false);
  });

  test("not an anonymous caller", () => {
    expect(isParticipant(offer, undefined)).toBe(false);
  });

  test("an offer with no requester is visible only to its creator", () => {
    expect(isParticipant({ creatorAddress: CREATOR, requesterAddress: null }, CREATOR)).toBe(true);
    expect(isParticipant({ creatorAddress: CREATOR, requesterAddress: null }, undefined)).toBe(false);
  });
});

function order(overrides: Partial<OnChainOrderDetails> = {}): OnChainOrderDetails {
  return {
    offerer: CREATOR,
    offerItemType: "ERC721",
    offerToken: REMIX,
    offerIdentifier: "5",
    offerAmount: "1",
    considerationItemType: "ERC20",
    considerationToken: "0x" + "d".repeat(64),
    considerationIdentifier: "0",
    considerationAmount: "100",
    considerationRecipient: CREATOR,
    royaltyMaxBps: "0",
    startTime: 0n,
    endTime: 1n,
    status: "active",
    ...overrides,
  };
}

function deps(overrides: Partial<RemixLinkDeps> = {}): RemixLinkDeps {
  return {
    collectionStandard: async () => "ERC721",
    ownsToken: async () => true,
    orderDetails: async () => order(),
    ...overrides,
  };
}

const link = { remixContract: REMIX, remixTokenId: "5", orderHash: ORDER_HASH };

describe("verifying a remix link against the chain", () => {
  test("accepts a token the creator holds and has listed", async () => {
    expect(await verifyRemixLink(deps(), CREATOR, link)).toEqual({ ok: true });
  });

  test("accepts a token id written in hex when the order carries it in decimal", async () => {
    expect(await verifyRemixLink(deps(), CREATOR, { ...link, remixTokenId: "0x5" })).toEqual({ ok: true });
  });

  test("refuses a collection the indexer does not know", async () => {
    const verdict = await verifyRemixLink(deps({ collectionStandard: async () => null }), CREATOR, link);
    expect(verdict).toMatchObject({ ok: false, status: 422 });
  });

  test("refuses a token the caller does not hold", async () => {
    const verdict = await verifyRemixLink(deps({ ownsToken: async () => false }), CREATOR, link);
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  test("refuses an order someone else made", async () => {
    const verdict = await verifyRemixLink(deps({ orderDetails: async () => order({ offerer: STRANGER }) }), CREATOR, link);
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  test("refuses an order for another contract", async () => {
    const verdict = await verifyRemixLink(deps({ orderDetails: async () => order({ offerToken: ORIGINAL }) }), CREATOR, link);
    expect(verdict).toMatchObject({ ok: false, status: 422 });
  });

  test("refuses an order for another token id", async () => {
    const verdict = await verifyRemixLink(deps({ orderDetails: async () => order({ offerIdentifier: "6" }) }), CREATOR, link);
    expect(verdict).toMatchObject({ ok: false, status: 422 });
  });

  test("refuses a token id that is not a number", async () => {
    const verdict = await verifyRemixLink(deps(), CREATOR, { ...link, remixTokenId: "five" });
    expect(verdict).toMatchObject({ ok: false, status: 422 });
  });

  test("asks to retry when the chain cannot be read for ownership", async () => {
    const verdict = await verifyRemixLink(deps({ ownsToken: async () => { throw new Error("rpc down"); } }), CREATOR, link);
    expect(verdict).toMatchObject({ ok: false, status: 503 });
  });

  test("asks to retry when the order cannot be read", async () => {
    const verdict = await verifyRemixLink(deps({ orderDetails: async () => { throw new Error("rpc down"); } }), CREATOR, link);
    expect(verdict).toMatchObject({ ok: false, status: 503 });
  });

  test("reads ownership and the order for the collection's own standard", async () => {
    const seen: string[] = [];
    await verifyRemixLink(
      deps({
        collectionStandard: async () => "ERC1155",
        ownsToken: async (_c, _t, _o, standard) => { seen.push(`owns:${standard}`); return true; },
        orderDetails: async (_h, standard) => { seen.push(`order:${standard}`); return order(); },
      }),
      CREATOR,
      link,
    );
    expect(seen).toEqual(["owns:ERC1155", "order:ERC1155"]);
  });
});
