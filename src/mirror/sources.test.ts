import { describe, expect, test } from "bun:test";
import { isDue, sourceFromBlock, collectionScopeWhere, EVENT_SOURCES, CORE_TRANSFERS, CORE_TRANSFERS_EXTERNAL, EXTERNAL_SERVICES } from "./sources.js";
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
      const isCore = ["marketplace-721", "marketplace-1155", "factory:mip-erc721", "factory:data-tokenization-erc721", "transfers", "transfers:external"].includes(s.id);
      expect(!!s.apply).toBe(!isCore);
    }
  });
  test("every source with a durable cursor is a known one", () => {
    for (const s of EVENT_SOURCES) {
      if (s.cadenceMs === undefined) continue;
      expect([
        "transfers", "transfers:external", "comments", "allowlist:pop", "allowlist:drop", "conditions:drop", "factory:creator-coin",
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

describe("a source that applies its own events keeps its own cursor", () => {
  test("every source with an apply step can be retried after a failure", () => {
    const unrecoverable = EVENT_SOURCES.filter((s) => s.apply && s.cadenceMs === undefined);
    expect(unrecoverable.map((s) => s.id)).toEqual([]);
  });

  test("comments are still read on every tick", () => {
    const comments = EVENT_SOURCES.find((s) => s.id === "comments")!;
    expect(isDue(comments.cadenceMs, Date.now(), Date.now())).toBe(true);
  });
});

describe("how often each collection is polled for transfers", () => {
  const scopeOf = (id: string) => {
    const source = EVENT_SOURCES.find((s) => s.id === id)!;
    if (source.scope.kind !== "collections") throw new Error(`${id} does not scope to collections`);
    return source.scope;
  };

  test("the two tiers between them cover every collection exactly once", () => {
    expect(scopeOf(CORE_TRANSFERS).excludeServices).toEqual(EXTERNAL_SERVICES);
    expect(scopeOf(CORE_TRANSFERS_EXTERNAL).services).toEqual(EXTERNAL_SERVICES);
  });

  test("collections indexed from someone else's marketplace order are polled less often", () => {
    const medialane = EVENT_SOURCES.find((s) => s.id === CORE_TRANSFERS)!.cadenceMs!;
    const external = EVENT_SOURCES.find((s) => s.id === CORE_TRANSFERS_EXTERNAL)!.cadenceMs!;
    expect(external).toBeGreaterThan(medialane);
  });

  test("each tier asks the database only for its own collections", () => {
    expect(collectionScopeWhere(scopeOf(CORE_TRANSFERS), "STARKNET", 10)).toMatchObject({
      service: { notIn: EXTERNAL_SERVICES },
    });
    expect(collectionScopeWhere(scopeOf(CORE_TRANSFERS_EXTERNAL), "STARKNET", 10)).toMatchObject({
      service: { in: EXTERNAL_SERVICES },
    });
  });

  test("a scope naming no service still covers every collection", () => {
    expect(collectionScopeWhere({ kind: "collections" }, "STARKNET", 10)).toEqual({
      chain: "STARKNET",
      startBlock: { lte: 10n },
    });
  });
});
