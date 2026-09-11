import { describe, expect, test } from "bun:test";
import { isDue, sourceFromBlock, EVENT_SOURCES } from "./sources.js";
import { acceptedTokens } from "../payments/token-value.js";

describe("isDue", () => {
  test("every-tick sources (no cadence) are always due", () => {
    expect(isDue(undefined, 999999, 1000000)).toBe(true);
  });
  test("cadence source is due when interval elapsed", () => {
    expect(isDue(120000, 0, 120000)).toBe(true);
    expect(isDue(120000, 100000, 219999)).toBe(false);
    expect(isDue(120000, undefined, 50)).toBe(true);
  });
});

describe("sourceFromBlock", () => {
  test("resumes after the stored cursor", () => {
    expect(sourceFromBlock(100n, 50)).toBe(101);
  });
  test("falls back to the main window start when no cursor exists", () => {
    expect(sourceFromBlock(null, 50)).toBe(50);
  });
});

describe("EVENT_SOURCES", () => {
  test("source ids are unique", () => {
    const ids = EVENT_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("core sources have no apply; side sources do", () => {
    for (const s of EVENT_SOURCES) {
      const isCore = ["marketplace-721", "marketplace-1155", "factory:mip-erc721", "factory:data-tokenization-erc721", "transfers"].includes(s.id);
      expect(!!s.apply).toBe(!isCore);
    }
  });
  test("only slow-cadence sources use a durable cursor", () => {
    for (const s of EVENT_SOURCES) {
      if (s.cadenceMs === undefined) continue;
      expect([
        "transfers", "allowlist:pop", "allowlist:drop", "conditions:drop", "factory:creator-coin",
        "factory:pop", "factory:drop", "factory:mip-erc1155",
        "factory:ip-tickets", "factory:ip-club", "ip-sponsorship",
        ...acceptedTokens().map((t) => `deposit:${t.symbol.toLowerCase()}`),
      ]).toContain(s.id);
    }
  });
});

describe("treasury deposits", () => {
  test("every accepted token is watched for deposits", () => {
    const ids = EVENT_SOURCES.map((s) => s.id);
    for (const token of acceptedTokens()) {
      expect(ids).toContain(`deposit:${token.symbol.toLowerCase()}`);
    }
  });

  test("a deposit source only sees transfers landing on the treasury", () => {
    const source = EVENT_SOURCES.find((s) => s.id === "deposit:strk");
    expect(source?.keyFilters?.length).toBe(2);
    expect(source?.keyFilters?.[1]?.length).toBe(1);
  });

  test("deposits are credited by a handler rather than inline", () => {
    const source = EVENT_SOURCES.find((s) => s.id === "deposit:strk");
    expect(typeof source?.apply).toBe("function");
  });
});

describe("where a source starts reading", () => {
  test("a cursor always wins", () => {
    expect(sourceFromBlock(500n, 1000, 100)).toBe(501);
  });

  test("without a cursor a configured start block is used", () => {
    expect(sourceFromBlock(null, 1000, 100)).toBe(100);
  });

  test("without either it follows the main window", () => {
    expect(sourceFromBlock(null, 1000)).toBe(1000);
  });

  test("deposit sources start early enough to see past deposits", () => {
    const source = EVENT_SOURCES.find((s) => s.id === "deposit:strk");
    expect(source?.startBlock).toBeLessThanOrEqual(14677219);
  });
});
