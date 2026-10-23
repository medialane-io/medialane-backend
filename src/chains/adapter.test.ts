import { describe, expect, test } from "bun:test";
import { verifyWalletSignature } from "../auth/verify.js";
import { getCollectionOwner, getEscapeReadyAt, holdsToken, holdsTokenId } from "../chainRead/index.js";
import { adapterFor, UnsupportedChain, type ChainAdapter } from "./adapter.js";

const fake: ChainAdapter = {
  holdsToken: async () => true,
  holdsTokenId: async () => true,
  collectionOwner: async () => "0x1",
  escapeReadyAt: async () => null,
  verifySignature: async () => ({ ok: true }),
};

describe("adapterFor", () => {
  test("returns the adapter registered for the chain", () => {
    expect(adapterFor("STARKNET", { STARKNET: fake })).toBe(fake);
  });

  test("the real registry serves Starknet with every capability", () => {
    const adapter = adapterFor("STARKNET");
    for (const capability of Object.keys(fake) as Array<keyof ChainAdapter>) {
      expect(typeof adapter[capability]).toBe("function");
    }
  });

  test("a chain with no adapter throws UnsupportedChain naming it", () => {
    let thrown: unknown;
    try {
      adapterFor("BASE");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnsupportedChain);
    expect((thrown as UnsupportedChain).chain).toBe("BASE");
    expect((thrown as Error).message).toContain("BASE");
  });
});

describe("the chain-keyed entry points refuse a chain with no adapter", () => {
  test("holdsToken", async () => {
    await expect(holdsToken("BASE", "0x1", "0x2", "ERC721")).rejects.toBeInstanceOf(UnsupportedChain);
  });

  test("holdsTokenId", async () => {
    await expect(holdsTokenId("BASE", "0x1", "0x2", "ERC721", "1")).rejects.toBeInstanceOf(UnsupportedChain);
  });

  test("getCollectionOwner", async () => {
    await expect(getCollectionOwner("BASE", "0x1")).rejects.toBeInstanceOf(UnsupportedChain);
  });

  test("getEscapeReadyAt", async () => {
    await expect(getEscapeReadyAt("BASE", "0x1")).rejects.toBeInstanceOf(UnsupportedChain);
  });

  test("verifyWalletSignature", async () => {
    await expect(
      verifyWalletSignature({ chain: "BASE", address: "0x1", typedData: {}, signature: ["0x1"] }),
    ).rejects.toBeInstanceOf(UnsupportedChain);
  });
});
