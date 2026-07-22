import { describe, it, expect } from "bun:test";
import { buildOfferListWhere, buildProposalListWhere } from "./sponsorship.filters.js";

describe("buildOfferListWhere", () => {
  it("defaults to Starknet, no filters", () => {
    expect(buildOfferListWhere({ chainFilter: { chain: "STARKNET" } }))
      .toEqual({ chain: "STARKNET" });
  });

  it("adds an OR clause from ownedPairs", () => {
    const where = buildOfferListWhere({
      chainFilter: { chain: "STARKNET" },
      ownedPairs: [{ contractAddress: "0xabc", tokenId: "1" }, { contractAddress: "0xabc", tokenId: "2" }],
    }) as { OR: unknown[] };
    expect(where.OR).toEqual([
      { nftContract: "0xabc", tokenId: "1" },
      { nftContract: "0xabc", tokenId: "2" },
    ]);
  });

  it("empty ownedPairs matches nothing", () => {
    const where = buildOfferListWhere({ chainFilter: { chain: "STARKNET" }, ownedPairs: [] }) as { OR: unknown[] };
    expect(where.OR).toEqual([]);
  });
});

describe("buildProposalListWhere", () => {
  it("adds an OR clause from ownedPairs", () => {
    const where = buildProposalListWhere({
      chainFilter: { chain: "STARKNET" },
      ownedPairs: [{ contractAddress: "0xdef", tokenId: "7" }],
    }) as { OR: unknown[] };
    expect(where.OR).toEqual([{ nftContract: "0xdef", tokenId: "7" }]);
  });
});
