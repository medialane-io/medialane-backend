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

describe("fetchCollectionMetadataJson gateway answers", () => {
  const GATEWAYS = ["https://1.1.1.1/ipfs", "https://1.0.0.1/ipfs"];
  const URI = "ipfs://bafkcollection";

  async function withFetch(
    respond: (url: string) => Response | Promise<Response>,
    run: (fetchJson: typeof import("./collectionMetadata.js").fetchCollectionMetadataJson) => Promise<void>,
  ) {
    const { fetchCollectionMetadataJson } = await import("./collectionMetadata.js");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => respond(input.toString())) as unknown as typeof fetch;
    try {
      await run(fetchCollectionMetadataJson);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("reads description and image from the first gateway that serves the JSON", async () => {
    await withFetch(
      (url) =>
        url.startsWith(GATEWAYS[0])
          ? new Response("rate limited", { status: 429 })
          : new Response(JSON.stringify({ name: "C", description: "d", image: "ipfs://img" }), { status: 200 }),
      async (fetchJson) => {
        expect(await fetchJson(URI, GATEWAYS)).toEqual({ description: "d", image: "ipfs://img" });
      },
    );
  });

  test("is null when no gateway answers, so the collection is retried", async () => {
    let call = 0;
    await withFetch(
      () => {
        call++;
        if (call === 1) return new Response("rate limited", { status: 429 });
        throw new Error("timeout");
      },
      async (fetchJson) => {
        expect(await fetchJson(URI, GATEWAYS)).toBeNull();
      },
    );
  });

  test("has null fields when a gateway answers that the document does not exist", async () => {
    await withFetch(
      () => new Response("not found", { status: 404 }),
      async (fetchJson) => {
        expect(await fetchJson(URI, GATEWAYS)).toEqual({ description: null, image: null });
      },
    );
  });

  test("has null fields when the document is not JSON", async () => {
    await withFetch(
      () => new Response("<html></html>", { status: 200 }),
      async (fetchJson) => {
        expect(await fetchJson(URI, GATEWAYS)).toEqual({ description: null, image: null });
      },
    );
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
