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

describe("detectTokenStandard", () => {
  const OZ_IERC721_ID = "0x33eb2f84c309543403fd69f0d0f363781ef06ef6faeb0131ff16ea3175bd943";
  const OZ_IERC1155_ID = "0x6114a8f75559e1b39fcba08ce02961a1aa082d9256a158dd3e64964e4b1b52";

  async function detectWith(supported: string[]) {
    const realStarknet = await import("../utils/starknet.js");
    const provider = {
      callContract: async (call: { calldata: string[] }) => {
        const id = BigInt(call.calldata[0]);
        return [supported.some((s) => BigInt(s) === id) ? "0x1" : "0x0"];
      },
    };
    const { mock } = await import("bun:test");
    mock.module("../utils/starknet.js", () => ({
      ...realStarknet,
      callRpc: (fn: (p: unknown) => unknown) => Promise.resolve(fn(provider)),
    }));
    const { detectTokenStandard } = await import("./collectionMetadata.js");
    return detectTokenStandard("0xc0de");
  }

  test("an OpenZeppelin ERC-721 is detected by its SRC5 interface id", async () => {
    expect(await detectWith([OZ_IERC721_ID])).toBe("ERC721");
  });

  test("an OpenZeppelin ERC-1155 is detected by its SRC5 interface id", async () => {
    expect(await detectWith([OZ_IERC1155_ID])).toBe("ERC1155");
  });

  test("a contract that supports neither is not a collection", async () => {
    expect(await detectWith([])).toBeNull();
  });
});
