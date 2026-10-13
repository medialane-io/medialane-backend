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
      expect(result).toBeNull();
      expect(fetchWasCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("fetchCollectionMetadataJson", () => {
  async function withFetch(responses: Record<string, Response>, run: () => Promise<void>) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const res = responses[input.toString()];
      if (!res) throw new Error("network error");
      return res;
    }) as unknown as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("reads collection.json from a directory base URI", async () => {
    const { fetchCollectionMetadataJson } = await import("./collectionMetadata.js");
    const body = { name: "C", description: "d", image: "ipfs://img" };
    await withFetch({ "https://1.1.1.1/dir/collection.json": new Response(JSON.stringify(body)) }, async () => {
      expect(await fetchCollectionMetadataJson("https://1.1.1.1/dir/")).toEqual(body);
    });
  });

  test("is null when the document cannot be fetched, so the collection is marked FAILED and retried", async () => {
    const { fetchCollectionMetadataJson } = await import("./collectionMetadata.js");
    await withFetch({}, async () => {
      expect(await fetchCollectionMetadataJson("https://1.1.1.1/unreachable.json")).toBeNull();
    });
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
