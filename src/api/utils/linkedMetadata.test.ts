import { describe, expect, test } from "bun:test";
import { linkedMetadata } from "./linkedMetadata.js";

const deps = (overrides: Partial<Parameters<typeof linkedMetadata>[1]> = {}) => ({
  metadata: async (uri: string) => ({ description: `from ${uri}`, external_url: `https://site.test/${uri}` }),
  timeoutMs: 1000,
  ...overrides,
});

describe("a token's description and external URL are read from the metadata at its stored link", () => {
  test("the stored token URI is used", async () => {
    expect(await linkedMetadata("ipfs://stored", deps())).toEqual({ description: "from ipfs://stored", externalUrl: "https://site.test/ipfs://stored" });
  });

  test("a token with no stored link gives none and reads nothing", async () => {
    let reads = 0;
    const counting = deps({ metadata: async () => { reads++; return { description: "d" }; } });
    expect(await linkedMetadata(null, counting)).toEqual({ description: null, externalUrl: null });
    expect(reads).toBe(0);
  });

  test("metadata without a description or external URL gives none", async () => {
    expect(await linkedMetadata("ipfs://x", deps({ metadata: async () => ({ name: "x" }) }))).toEqual({ description: null, externalUrl: null });
  });

  test("a failed read gives none instead of failing the page", async () => {
    const failing = deps({ metadata: async () => { throw new Error("gateway down"); } });
    expect(await linkedMetadata("ipfs://x", failing)).toEqual({ description: null, externalUrl: null });
  });

  test("metadata that never arrives returns no description after the wait", async () => {
    const hanging = { ...deps({ metadata: () => new Promise<Record<string, unknown> | null>(() => {}) }), timeoutMs: 50 };
    expect(await linkedMetadata("ipfs://x", hanging)).toEqual({ description: null, externalUrl: null });
  });

  test("metadata that arrives within the wait is served", async () => {
    const slow = {
      ...deps({ metadata: () => new Promise<Record<string, unknown> | null>((resolve) => setTimeout(() => resolve({ description: "d", external_url: "https://e.example" }), 20)) }),
      timeoutMs: 50,
    };
    expect(await linkedMetadata("ipfs://x", slow)).toEqual({ description: "d", externalUrl: "https://e.example" });
  });
});
