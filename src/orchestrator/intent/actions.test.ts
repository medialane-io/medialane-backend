import { describe, expect, test } from "bun:test";
import { CallData, cairo } from "starknet";
import { getTokenBySymbol, STARKNET_NFTCOMMENTS_CONTRACT, STARKNET_GENESIS_MINT_CONTRACT, STARKNET_GENESIS_NFT_URI, STARKNET_COLLECTION_721_CONTRACT } from "@medialane/sdk";
import { encodeByteArray } from "@medialane/sdk/starknet";
import {
  buildTransferTokenIntent,
  buildTransferNftIntent,
  buildTransferCollectionOwnershipIntent,
  buildCommentIntent,
  buildGenesisMintIntent,
} from "./actions.js";

const OWNER = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER = "0x0fedcba9876543210fedcba9876543210fedcba9876543210fedcba987654321";
const STRK = getTokenBySymbol("STRK")!.address;
const felts = (xs: readonly (string | number | bigint)[]) => xs.map((x) => BigInt(x));

function ioByteArray(str: string) {
  const bytes = new TextEncoder().encode(str);
  const data: string[] = [];
  let i = 0;
  while (i + 31 <= bytes.length) {
    let value = 0n;
    for (let j = 0; j < 31; j++) value = (value << 8n) | BigInt(bytes[i + j]!);
    data.push("0x" + value.toString(16));
    i += 31;
  }
  let pending = 0n;
  for (const b of bytes.slice(i)) pending = (pending << 8n) | BigInt(b);
  return { data, pending_word: "0x" + pending.toString(16), pending_word_len: bytes.length - i };
}

describe("action intents", () => {
  test("token transfer is one ERC-20 transfer of a supported token", async () => {
    const { calls } = await buildTransferTokenIntent({ owner: OWNER, token: STRK, recipient: OTHER, amount: "5" });
    const u = cairo.uint256(5);
    expect(calls).toEqual([{ contractAddress: STRK, entrypoint: "transfer", calldata: [OTHER, String(u.low), String(u.high)] }]);
  });

  test("token transfer refuses a token Medialane does not list", async () => {
    await expect(buildTransferTokenIntent({ owner: OWNER, token: "0x999", recipient: OTHER, amount: "5" })).rejects.toThrow();
  });

  test("ERC-721 transfer uses transfer_from from the owner", async () => {
    const { calls } = await buildTransferNftIntent({ owner: OWNER, contractAddress: OTHER, tokenId: "7", recipient: OTHER, tokenStandard: "ERC721" });
    expect(calls[0]).toEqual({ contractAddress: OTHER, entrypoint: "transfer_from", calldata: [OWNER, OTHER, "7", "0"] });
  });

  test("ERC-1155 transfer moves one unit with empty data", async () => {
    const { calls } = await buildTransferNftIntent({ owner: OWNER, contractAddress: OTHER, tokenId: "7", recipient: OTHER, tokenStandard: "ERC1155" });
    expect(calls[0]).toEqual({ contractAddress: OTHER, entrypoint: "safe_transfer_from", calldata: [OWNER, OTHER, "7", "0", "1", "0", "0"] });
  });

  test("collection ownership transfer targets the collection registry", async () => {
    const { calls } = await buildTransferCollectionOwnershipIntent({ owner: OWNER, collectionId: "4", newOwner: OTHER });
    expect(calls[0]!.contractAddress).toBe(STARKNET_COLLECTION_721_CONTRACT);
    expect(calls[0]!.entrypoint).toBe("transfer_collection_ownership");
    expect(felts(calls[0]!.calldata)).toEqual(felts(["4", "0", OTHER]));
  });

  test("comment posts UTF-8 text to the comments contract exactly as io encodes it", async () => {
    const text = "olá 🎨 obra incrível de verdade, parabéns!";
    const { calls } = await buildCommentIntent({ author: OWNER, nftContract: OTHER, tokenId: "7", text });
    const expected = CallData.compile([OTHER, { low: "7", high: "0" }, ioByteArray(text)]);
    expect(calls[0]!.contractAddress).toBe(STARKNET_NFTCOMMENTS_CONTRACT);
    expect(calls[0]!.entrypoint).toBe("add_comment");
    expect(felts(calls[0]!.calldata)).toEqual(felts(expected));
  });

  test("genesis mint mints the genesis item to the recipient as io encodes it", async () => {
    const { calls } = await buildGenesisMintIntent({ owner: OWNER, recipient: OWNER });
    expect(calls).toEqual([{ contractAddress: STARKNET_GENESIS_MINT_CONTRACT, entrypoint: "mint_item", calldata: [OWNER, ...encodeByteArray(STARKNET_GENESIS_NFT_URI)] }]);
  });
});
