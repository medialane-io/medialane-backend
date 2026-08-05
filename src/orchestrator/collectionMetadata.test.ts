import { describe, expect, test } from "bun:test";

// isPrivateOrInsecureUrl is real dependency-injected; here we assert the
// production code path actually calls the guarded fetcher, by checking that
// a URL it would reject never reaches global fetch.
describe("collectionMetadata SSRF guard", () => {
  test("fetchCollectionMetadataJson blocks a URL that resolves to a private address", async () => {
    const { fetchCollectionMetadataJson } = await import("./collectionMetadata.js");
    const originalFetch = globalThis.fetch;
    let fetchWasCalled = false;
    globalThis.fetch = (async () => {
      fetchWasCalled = true;
      return new Response(JSON.stringify({ image: "http://evil", description: "d" }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      // A bare (non-ipfs://) baseUri pointing at a private/loopback host —
      // isPrivateOrInsecureUrl must reject it before fetch() ever runs.
      const result = await fetchCollectionMetadataJson("http://127.0.0.1:9999/collection.json");
      expect(result).toEqual({ description: null, image: null });
      expect(fetchWasCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
