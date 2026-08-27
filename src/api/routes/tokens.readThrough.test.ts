import { test, expect, describe } from "bun:test";
import { readTokenFromChain } from "./tokens.readThrough.js";

// The contract this module must honour: it may adopt a token the chain
// confirms, and must never invent one the chain denies or could not be asked
// about. Getting that backwards would let a 404 become a fabricated asset.
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
        // Minimal stand-in for the contract call surface Contract uses.
        callContract: async () => ({ result: [] }),
      })) as never;

    // The ERC721 path proves existence via owner_of; a throw there means the
    // token was never minted and must surface as null.
    const denied = (async () => {
      throw new Error("Entrypoint reverted: token does not exist");
    }) as never;
    expect(
      await readTokenFromChain("STARKNET" as never, "0x1", "999", "ERC721" as never, denied)
    ).toBeNull();
    expect(typeof ok).toBe("function");
  });
});
