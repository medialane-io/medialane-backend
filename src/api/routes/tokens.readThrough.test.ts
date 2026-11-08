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
      await readTokenFromChain("STARKNET" as never, "0x1", "1", { standard: "ERC721", service: "mip-erc721" }, failing)
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
      await readTokenFromChain("STARKNET" as never, "0x1", "999", { standard: "ERC721", service: "mip-erc721" }, denied)
    ).toBeNull();
    expect(typeof ok).toBe("function");
  });

  const byteArray = (text: string) => {
    const hex = Buffer.from(text).toString("hex");
    return ["0x0", `0x${hex}`, `0x${text.length.toString(16)}`];
  };
  const contract = (answers: Record<string, string[]>) =>
    (async (fn: (p: unknown) => Promise<unknown>) =>
      fn({
        callContract: async ({ entrypoint }: { entrypoint: string }) => {
          const answer = answers[entrypoint];
          if (!answer) throw Object.assign(new Error("entrypoint not found"), { code: 21 });
          return answer;
        },
      })) as never;
  const mip1155 = { standard: "ERC1155" as const, service: "mip-erc1155" };

  test("an ERC1155 token the contract has not minted is not adopted, although uri answers for any id", async () => {
    const rpc = contract({ token_exists: ["0x0"], uri: byteArray("ipfs://collection") });
    expect(await readTokenFromChain("STARKNET" as never, "0x1", "12", mip1155, rpc)).toBeNull();
  });

  test("a minted ERC1155 token is adopted with its own uri", async () => {
    const rpc = contract({ token_exists: ["0x1"], uri: byteArray("ipfs://token-4") });
    expect(await readTokenFromChain("STARKNET" as never, "0x1", "4", mip1155, rpc)).toEqual({ tokenUri: "ipfs://token-4" });
  });
});
