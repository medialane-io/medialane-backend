import { describe, expect, test } from "bun:test";

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

      const result = await fetchCollectionMetadataJson("http://127.0.0.1:9999/collection.json");
      expect(result).toEqual({ description: null, image: null });
      expect(fetchWasCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("resolveCollectionBaseUri", () => {
  test("keeps the base URI indexed from the factory when the contract has no base_uri getter", async () => {
    const { resolveCollectionBaseUri } = await import("./collectionMetadata.js");
    expect(resolveCollectionBaseUri("", "ipfs://bafy/event.json")).toBe("ipfs://bafy/event.json");
  });

  test("prefers the on-chain value when the contract exposes one", async () => {
    const { resolveCollectionBaseUri } = await import("./collectionMetadata.js");
    expect(resolveCollectionBaseUri("ipfs://chain/", "ipfs://stored/")).toBe("ipfs://chain/");
  });

  test("is empty when neither is known", async () => {
    const { resolveCollectionBaseUri } = await import("./collectionMetadata.js");
    expect(resolveCollectionBaseUri("", null)).toBe("");
  });
});
