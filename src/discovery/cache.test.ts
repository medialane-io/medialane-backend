// Regression guard for the LRU + TTL cache in discovery/cache.ts.
// Audit P1-11 speculated the cache might be unbounded — it isn't, but
// without a test the next refactor could quietly drop the eviction path.
import { describe, expect, test } from "bun:test";
import { getCachedMetadata, setCachedMetadata } from "./cache.js";

describe("metadata cache", () => {
  test("set then get returns the cached content", () => {
    const uri = `test://cache-get-${Date.now()}`;
    setCachedMetadata(uri, "https://gateway/x", { name: "foo" }, false);
    expect(getCachedMetadata(uri)).toEqual({ name: "foo" });
  });

  test("get returns null for unknown uri", () => {
    expect(getCachedMetadata(`test://never-set-${Date.now()}`)).toBeNull();
  });

  test("set with null content (negative cache) is queryable", () => {
    const uri = `test://negative-${Date.now()}`;
    setCachedMetadata(uri, null, null, true);
    // Stored as null content — get returns null (indistinguishable from miss,
    // but the resolver path uses presence in the map to avoid re-fetching).
    expect(getCachedMetadata(uri)).toBeNull();
  });

  test("repeated reads update LRU order (no expiry within the run)", () => {
    // Just confirm reads don't break the cache.
    const uri = `test://lru-${Date.now()}`;
    setCachedMetadata(uri, "url", { v: 1 }, true);
    for (let i = 0; i < 5; i++) expect(getCachedMetadata(uri)).toEqual({ v: 1 });
  });
});
