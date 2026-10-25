import { describe, expect, test } from "bun:test";
import { countMemberships } from "./club-onchain.js";

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
