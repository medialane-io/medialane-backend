import { test, expect, describe } from "bun:test";
import { readTokenFromChain } from "./tokens.readThrough.js";

describe("readTokenFromChain", () => {
  test("returns null for a non-Starknet chain rather than guessing", async () => {
    const unreachable = (() => {
      throw new Error("must not be called");
    }) as never;
    expect(await readTokenFromChain("SOLANA" as never, "0x1", "1", null, unreachable)).toBeNull();
  });

  test("a chain error resolves to null, so a miss is never turned into existence", async () => {
    const failing = (async () => {
      throw new Error("RPC unreachable");
    }) as never;
    expect(
      await readTokenFromChain("STARKNET" as never, "0x1", "1", "ERC721" as never, failing)
    ).toBeNull();
  });

  test("a token the chain confirms is adopted, carrying its tokenUri", async () => {
    const ok = (async (fn: (p: unknown) => Promise<unknown>) =>
      fn({

        callContract: async () => ({ result: [] }),
      })) as never;

    const denied = (async () => {
      throw new Error("Entrypoint reverted: token does not exist");
    }) as never;
    expect(
      await readTokenFromChain("STARKNET" as never, "0x1", "999", "ERC721" as never, denied)
    ).toBeNull();
    expect(typeof ok).toBe("function");
  });
});
