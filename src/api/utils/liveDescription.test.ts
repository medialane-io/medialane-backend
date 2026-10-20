import { describe, expect, test } from "bun:test";
import { liveDescription } from "./liveDescription.js";

const deps = (overrides: Partial<Parameters<typeof liveDescription>[4]> = {}) => ({
  tokenUri: async () => "ipfs://from-chain",
  metadata: async (uri: string) => ({ description: `from ${uri}` }),
  timeoutMs: 50,
  ...overrides,
});

describe("a token's description is read from its own metadata", () => {
  test("the stored token URI is used when there is one", async () => {
    expect(await liveDescription("STARKNET", "0xc", "1", "ipfs://stored", deps())).toBe("from ipfs://stored");
  });

  test("the token URI is read from the chain when none is stored", async () => {
    expect(await liveDescription("STARKNET", "0xc", "1", null, deps())).toBe("from ipfs://from-chain");
  });

  test("metadata without a description gives none", async () => {
    expect(await liveDescription("STARKNET", "0xc", "1", "ipfs://x", deps({ metadata: async () => ({ name: "x" }) }))).toBeNull();
  });

  test("a failed read gives none instead of failing the page", async () => {
    const failing = deps({ metadata: async () => { throw new Error("gateway down"); } });
    expect(await liveDescription("STARKNET", "0xc", "1", "ipfs://x", failing)).toBeNull();
  });

  test("a slow read gives none after the timeout", async () => {
    const slow = deps({ metadata: () => new Promise((resolve) => setTimeout(() => resolve({ description: "late" }), 500)) });
    expect(await liveDescription("STARKNET", "0xc", "1", "ipfs://x", slow)).toBeNull();
  });
});
