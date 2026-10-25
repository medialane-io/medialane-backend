import { describe, expect, test } from "bun:test";
import { liveMetadata } from "./liveMetadata.js";

const deps = (overrides: Partial<Parameters<typeof liveMetadata>[4]> = {}) => ({
  tokenUri: async () => "ipfs://from-chain",
  metadata: async (uri: string) => ({ description: `from ${uri}`, external_url: `https://site.test/${uri}` }),
  timeoutMs: 50,
  ...overrides,
});

describe("a token's description and external URL are read from its own metadata", () => {
  test("the stored token URI is used when there is one", async () => {
    expect(await liveMetadata("STARKNET", "0xc", "1", "ipfs://stored", deps())).toEqual({ description: "from ipfs://stored", externalUrl: "https://site.test/ipfs://stored" });
  });

  test("the token URI is read from the chain when none is stored", async () => {
    expect(await liveMetadata("STARKNET", "0xc", "1", null, deps())).toEqual({ description: "from ipfs://from-chain", externalUrl: "https://site.test/ipfs://from-chain" });
  });

  test("metadata without a description or external URL gives none", async () => {
    expect(await liveMetadata("STARKNET", "0xc", "1", "ipfs://x", deps({ metadata: async () => ({ name: "x" }) }))).toEqual({ description: null, externalUrl: null });
  });

  test("a failed read gives none instead of failing the page", async () => {
    const failing = deps({ metadata: async () => { throw new Error("gateway down"); } });
    expect(await liveMetadata("STARKNET", "0xc", "1", "ipfs://x", failing)).toEqual({ description: null, externalUrl: null });
  });

  test("a slow read gives none after the timeout", async () => {
    const slow = deps({ metadata: () => new Promise((resolve) => setTimeout(() => resolve({ description: "late" }), 500)) });
    expect(await liveMetadata("STARKNET", "0xc", "1", "ipfs://x", slow)).toEqual({ description: null, externalUrl: null });
  });
});
