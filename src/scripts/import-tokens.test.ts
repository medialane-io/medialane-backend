import { describe, expect, test } from "bun:test";
import { num, hash } from "starknet";
import { mintedTokenIds, ownedFacts } from "./import-tokens.js";
import type { RawStarknetEvent } from "../types/starknet.js";

const C = "0xc";
const SEL = num.toHex(hash.getSelectorFromName("Transfer"));
let tx = 0;
const transfer = (from: string, to: string, tokenId: number): RawStarknetEvent => ({
  block_hash: "0x1",
  block_number: 1,
  transaction_hash: num.toHex(++tx),
  from_address: C,
  keys: [SEL, from, to, num.toHex(tokenId), "0x0"],
  data: [],
});
const erc721 = (tokenId: string, owner: string | null) =>
  ({ standard: "ERC721" as const, contractAddress: C, tokenId, owner });

describe("token ids minted by a collection", () => {
  test("only transfers from the zero address count as mints", () => {
    expect(mintedTokenIds([transfer("0x0", "0xa", 1), transfer("0xa", "0xb", 1), transfer("0x0", "0xb", 2)]))
      .toEqual(["1", "2"]);
  });

  test("ids are unique and in numeric order", () => {
    expect(mintedTokenIds([transfer("0x0", "0xa", 10), transfer("0x0", "0xa", 9), transfer("0x0", "0xa", 10)]))
      .toEqual(["9", "10"]);
  });
});

describe("tokens kept for import", () => {
  test("tokens with no owner are left out", () => {
    expect(ownedFacts([erc721("1", "0xa"), erc721("2", null)])).toEqual([erc721("1", "0xa")]);
  });
});
