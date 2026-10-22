

import { describe, expect, test } from "bun:test";
import { createMetadataCache, getCachedMetadata, setCachedMetadata } from "./cache.js";

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

    expect(getCachedMetadata(uri)).toBeNull();
  });

  test("repeated reads update LRU order (no expiry within the run)", () => {

    const uri = `test://lru-${Date.now()}`;
    setCachedMetadata(uri, "url", { v: 1 }, true);
    for (let i = 0; i < 5; i++) expect(getCachedMetadata(uri)).toEqual({ v: 1 });
  });

  test("evicts the least recently used documents to stay within the byte budget", () => {
    const cache = createMetadataCache(100);
    cache.set("a", "url", { v: "x".repeat(30) }, true);
    cache.set("b", "url", { v: "y".repeat(30) }, true);
    cache.get("a");
    cache.set("c", "url", { v: "z".repeat(30) }, true);
    expect(cache.get("a")).toEqual({ v: "x".repeat(30) });
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toEqual({ v: "z".repeat(30) });
    expect(cache.bytes).toBeLessThanOrEqual(100);
  });

  test("a document larger than the budget is not cached and evicts nothing", () => {
    const cache = createMetadataCache(100);
    cache.set("small", "url", { v: 1 }, true);
    cache.set("large", "url", { v: "x".repeat(200) }, true);
    expect(cache.get("large")).toBeNull();
    expect(cache.get("small")).toEqual({ v: 1 });
  });

  test("replacing an entry releases its bytes", () => {
    const cache = createMetadataCache(100);
    cache.set("a", "url", { v: "x".repeat(50) }, true);
    cache.set("a", "url", { v: 1 }, true);
    expect(cache.bytes).toBe(Buffer.byteLength(JSON.stringify({ v: 1 })));
  });

  test("the entry count is still bounded", () => {
    const cache = createMetadataCache(1_000_000, 2);
    cache.set("a", "url", { v: 1 }, true);
    cache.set("b", "url", { v: 2 }, true);
    cache.set("c", "url", { v: 3 }, true);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("c")).toEqual({ v: 3 });
  });
});
