import { describe, expect, test, mock } from "bun:test";
import { composeAmountDisplay, batchOrdersByToken, serializeCreatorProfile } from "./serialize.js";

describe("composeAmountDisplay", () => {
  test("joins value and currency into the API display shape", () => {
    expect(composeAmountDisplay("1.500000", "USDC")).toBe("1.500000 USDC");
    expect(composeAmountDisplay("0.010000000000000000", "ETH")).toBe("0.010000000000000000 ETH");
  });

  test("null/empty value → null (no floor / no volume)", () => {
    expect(composeAmountDisplay(null, "USDC")).toBeNull();
    expect(composeAmountDisplay(undefined, null)).toBeNull();
    expect(composeAmountDisplay("", "USDC")).toBeNull();
  });

  test("value without currency passes through (pre-split legacy rows)", () => {
    expect(composeAmountDisplay("1.500000", null)).toBe("1.500000");
    expect(composeAmountDisplay("1.500000", undefined)).toBe("1.500000");
  });
});

describe("batchOrdersByToken", () => {
  test("groups active orders by contractAddress:tokenId, one query for all tokens", async () => {
    const findMany = mock(async () => [
      { id: "o1", chain: "STARKNET", nftContract: "0xabc", nftTokenId: "1", status: "ACTIVE" },
      { id: "o2", chain: "STARKNET", nftContract: "0xabc", nftTokenId: "1", status: "ACTIVE" },
      { id: "o3", chain: "STARKNET", nftContract: "0xdef", nftTokenId: "2", status: "ACTIVE" },
    ]);
    const result = await batchOrdersByToken(
      [
        { chain: "STARKNET", contractAddress: "0xabc", tokenId: "1" },
        { chain: "STARKNET", contractAddress: "0xdef", tokenId: "2" },
      ],
      { order: { findMany } } as any,
    );
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(result.get("0xabc:1")).toHaveLength(2);
    expect(result.get("0xdef:2")).toHaveLength(1);
    expect(result.get("0xnotfound:9")).toBeUndefined();
  });

  test("returns an empty Map for an empty token list without querying", async () => {
    const findMany = mock(async () => []);
    const result = await batchOrdersByToken([], { order: { findMany } } as any);
    expect(findMany).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });
});

describe("serializeCreatorProfile", () => {
  test("shapes a profile + wallet address into the public creator response, including timestamps", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const updatedAt = new Date("2026-02-01T00:00:00.000Z");
    const result = serializeCreatorProfile(
      {
        username: "alice",
        displayName: "Alice",
        bio: "hi",
        avatarImage: null,
        websiteUrl: null,
        twitterUrl: null,
        discordUrl: null,
        telegramUrl: null,
        createdAt,
        updatedAt,
      },
      "0xwallet",
    );
    expect(result).toEqual({
      walletAddress: "0xwallet",
      username: "alice",
      displayName: "Alice",
      bio: "hi",
      avatarImage: null,
      websiteUrl: null,
      twitterUrl: null,
      discordUrl: null,
      telegramUrl: null,
      createdAt,
      updatedAt,
    });
  });
});
