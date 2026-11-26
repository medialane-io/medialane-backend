import { describe, expect, mock, test } from "bun:test";
import { normalizeAddress } from "@medialane/sdk";

const OWNER = normalizeAddress("STARKNET", "0x1");
const COLLECTION = normalizeAddress("STARKNET", "0x3");

const real = await import("../../utils/starknet.js");
const reads: string[] = [];
mock.module("../../utils/starknet.js", () => ({
  ...real,
  callRpc: async (fn: (provider: unknown) => unknown) =>
    fn({
      callContract: async ({ entrypoint }: { entrypoint: string }) => {
        reads.push(entrypoint);
        return entrypoint === "owner" ? [OWNER] : ["0x4", "0x0"];
      },
    }),
}));

let service = "mip-erc1155";
mock.module("../../utils/collection.js", () => ({ resolveServiceForContract: async () => service }));

const { buildMintIntent } = await import("./collection.js");

const edition = { owner: OWNER, recipient: "0x2", collectionContract: COLLECTION, tokenUri: "ipfs://x", value: "10" };

describe("ERC-1155 mint royalty", () => {
  test("a royalty is set on the new edition in the same transaction, paid to the owner", async () => {
    const { calls } = await buildMintIntent({ ...edition, royaltyBps: 500 } as never);

    expect(calls.map((c) => c.entrypoint)).toEqual(["mint_edition", "set_token_royalty"]);
    expect(calls[1]!.contractAddress).toBe(COLLECTION);
    expect((calls[1]!.calldata as string[]).map((x) => BigInt(x))).toEqual([5n, 0n, BigInt(OWNER), 500n]);
  });

  test("without a royalty the mint is a single call and the edition count is not read", async () => {
    reads.length = 0;
    const { calls } = await buildMintIntent({ ...edition, royaltyBps: 0 } as never);

    expect(calls.map((c) => c.entrypoint)).toEqual(["mint_edition"]);
    expect(reads).toEqual(["owner"]);
  });

  test("a tier mint still refuses a royalty", async () => {
    service = "ip-club";
    const err = await buildMintIntent({ owner: OWNER, recipient: "0x2", collectionContract: COLLECTION, tokenId: "1", amount: "1", royaltyBps: 500 } as never).catch((e) => e);
    expect(err.message).toContain("CREATE_TIER");
    service = "mip-erc1155";
  });
});
