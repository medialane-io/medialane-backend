import { describe, expect, test } from "bun:test";
import { isDue, sourceFromBlock, EVENT_SOURCES } from "./sources.js";

describe("isDue", () => {
  test("every-tick sources (no cadence) are always due", () => {
    expect(isDue(undefined, 999999, 1000000)).toBe(true);
  });
  test("cadence source is due when interval elapsed", () => {
    expect(isDue(120000, 0, 120000)).toBe(true);
    expect(isDue(120000, 100000, 219999)).toBe(false);
    expect(isDue(120000, undefined, 50)).toBe(true); // never polled → due
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
      const isCore = ["marketplace-721", "marketplace-1155", "factory:mip-erc721", "transfers"].includes(s.id);
      expect(!!s.apply).toBe(!isCore);
    }
  });
  test("only slow-cadence sources use a durable cursor", () => {
    for (const s of EVENT_SOURCES) {
      if (s.cadenceMs === undefined) continue;
      expect([
        "transfers", "allowlist:pop", "allowlist:drop", "factory:creator-coin",
        "factory:pop", "factory:drop", "factory:mip-erc1155",
        "factory:ip-tickets", "factory:ip-club", "ip-sponsorship",
      ]).toContain(s.id);
    }
  });
});
