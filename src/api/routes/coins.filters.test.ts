import { describe, it, expect } from "bun:test";
import { buildCoinListWhere, buildCoinListOrderBy, buildAdminCoinWhere } from "./coins.filters.js";
import { normalizeAddress } from "@medialane/sdk";

const ADDR = "0x123abc";
const NORM = normalizeAddress("STARKNET", ADDR);

describe("buildCoinListWhere", () => {
  it("defaults to visible Starknet coins, no filters", () => {
    expect(buildCoinListWhere({})).toEqual({ chain: "STARKNET", isHidden: false });
  });
  it("adds service when given", () => {
    expect(buildCoinListWhere({ service: "creator-coin" }))
      .toEqual({ chain: "STARKNET", isHidden: false, service: "creator-coin" });
  });
  it("normalizes the creator address", () => {
    expect(buildCoinListWhere({ creator: ADDR }))
      .toEqual({ chain: "STARKNET", isHidden: false, creator: NORM });
  });
});

describe("buildCoinListOrderBy", () => {
  it("sorts by name", () => {
    expect(buildCoinListOrderBy("name")).toEqual({ name: "asc" });
  });
  it("defaults to recent for undefined", () => {
    expect(buildCoinListOrderBy(undefined)).toEqual({ createdAt: "desc" });
  });
  it("defaults to recent for an unknown value", () => {
    expect(buildCoinListOrderBy("volume")).toEqual({ createdAt: "desc" });
  });
});

describe("buildAdminCoinWhere", () => {
  it("includes hidden coins (no isHidden filter), no search", () => {
    expect(buildAdminCoinWhere({})).toEqual({ chain: "STARKNET" });
  });
  it("text search matches name + symbol but NOT address", () => {
    const where = buildAdminCoinWhere({ search: "brother" }) as { OR: unknown[] };
    expect(where.OR).toEqual([
      { name: { contains: "brother", mode: "insensitive" } },
      { symbol: { contains: "brother", mode: "insensitive" } },
    ]);
  });
  it("hex search adds a normalized contractAddress term", () => {
    const where = buildAdminCoinWhere({ search: ADDR }) as { OR: unknown[] };
    expect(where.OR).toContainEqual({ contractAddress: NORM });
  });
});
