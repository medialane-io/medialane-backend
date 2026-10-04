import { describe, expect, test } from "bun:test";
import { countMemberships, parseMembershipResult } from "./club-onchain.js";

describe("parseMembershipResult", () => {
  test("parses a membership with both start and end time set", () => {
    const raw = {
      max_supply: 200n,
      minted: 5n,
      start_time: { unwrap: () => 1700000000n },
      end_time: { unwrap: () => 1800000000n },
      royalty_bps: 500,
    };
    expect(parseMembershipResult(raw)).toEqual({
      maxSupply: "200",
      minted: "5",
      startTime: 1700000000,
      endTime: 1800000000,
      royaltyBps: 500,
    });
  });

  test("parses a membership with no validity window (CairoOption::None)", () => {
    const raw = { max_supply: 50n, minted: 0n, start_time: undefined, end_time: undefined, royalty_bps: 0 };
    expect(parseMembershipResult(raw)).toEqual({
      maxSupply: "50",
      minted: "0",
      startTime: null,
      endTime: null,
      royaltyBps: 0,
    });
  });
});

describe("countMemberships", () => {
  function tiers(n: number, onMissing: "throw" | "zero" = "throw") {
    const reads: number[] = [];
    const exists = async (id: number) => {
      reads.push(id);
      if (id <= n) return true;
      if (onMissing === "throw") throw new Error("no such membership");
      return false;
    };
    return { exists, reads };
  }

  test("a club with no tiers has a count of 0", async () => {
    expect(await countMemberships(tiers(0).exists)).toBe(0);
  });

  test("the count is the highest tier that exists", async () => {
    for (const n of [1, 2, 3, 5, 8, 13, 64, 100]) {
      expect(await countMemberships(tiers(n).exists)).toBe(n);
    }
  });

  test("a missing tier read as empty counts the same as one that fails", async () => {
    expect(await countMemberships(tiers(7, "zero").exists)).toBe(7);
  });

  test("counting a club takes a handful of reads, not one per tier", async () => {
    const t = tiers(100);
    await countMemberships(t.exists);
    expect(t.reads.length).toBeLessThanOrEqual(16);
  });
});
