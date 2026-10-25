import { describe, expect, test } from "bun:test";
import { parseTierResult } from "./tierOnchain.js";

describe("parseTierResult", () => {
  test("parses a tier with both start and end time set", () => {
    const raw = {
      max_supply: 500n,
      minted: 12n,
      start_time: { unwrap: () => 1000n },
      end_time: { unwrap: () => 2000n },
      royalty_bps: 250,
    };
    expect(parseTierResult(raw)).toEqual({
      maxSupply: "500",
      minted: "12",
      startTime: 1000,
      endTime: 2000,
      royaltyBps: 250,
    });
  });

  test("parses a tier with no validity window (CairoOption::None)", () => {
    const raw = { max_supply: 10n, minted: 0n, start_time: undefined, end_time: undefined, royalty_bps: 0 };
    expect(parseTierResult(raw)).toEqual({
      maxSupply: "10",
      minted: "0",
      startTime: null,
      endTime: null,
      royaltyBps: 0,
    });
  });
});
