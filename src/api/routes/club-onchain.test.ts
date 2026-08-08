import { describe, expect, test } from "bun:test";
import { parseMembershipResult } from "./club-onchain.js";

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
