

import { afterEach, describe, expect, test } from "bun:test";
import { getCachedMetadata, setCachedMetadata } from "./cache.js";

const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

describe("metadata cache", () => {
  test("set then get returns the cached content", () => {
    const uri = `test://cache-get-${Date.now()}`;
    setCachedMetadata(uri, "https://gateway/x", { name: "foo" }, false);
    expect(getCachedMetadata(uri)).toEqual({ content: { name: "foo" } });
  });

  test("get returns undefined for unknown uri", () => {
    expect(getCachedMetadata(`test://never-set-${Date.now()}`)).toBeUndefined();
  });

  test("a remembered failure is a hit with null content", () => {
    const uri = `test://negative-${Date.now()}`;
    setCachedMetadata(uri, null, null, true);
    expect(getCachedMetadata(uri)).toEqual({ content: null });
  });

  test("a failure is remembered for ten minutes only", () => {
    const uri = `test://negative-ttl-${Date.now()}`;
    setCachedMetadata(uri, null, null, true);
    const start = Date.now();
    Date.now = () => start + 9 * 60 * 1000;
    expect(getCachedMetadata(uri)).toEqual({ content: null });
    Date.now = () => start + 10 * 60 * 1000 + 1;
    expect(getCachedMetadata(uri)).toBeUndefined();
  });

  test("a successful IPFS read outlives the failure window", () => {
    const uri = `test://positive-ttl-${Date.now()}`;
    setCachedMetadata(uri, "url", { v: 1 }, true);
    const start = Date.now();
    Date.now = () => start + 60 * 60 * 1000;
    expect(getCachedMetadata(uri)).toEqual({ content: { v: 1 } });
  });

  test("repeated reads update LRU order (no expiry within the run)", () => {

    const uri = `test://lru-${Date.now()}`;
    setCachedMetadata(uri, "url", { v: 1 }, true);
    for (let i = 0; i < 5; i++) expect(getCachedMetadata(uri)).toEqual({ content: { v: 1 } });
  });
});
