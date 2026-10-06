import { describe, expect, test } from "bun:test";
import { getTokenBySymbol } from "@medialane/sdk";
import { isNftTransferEvent } from "./_shared.js";

describe("which transfers in a receipt are applied as NFT moves", () => {
  const nft = { type: "Transfer", contractAddress: "0xc0ffee", tokenId: "1", from: "0x1", to: "0x2", blockNumber: 1n, txHash: "0x1", logIndex: 0 } as const;

  test("an NFT transfer is applied", () => {
    expect(isNftTransferEvent(nft as never)).toBe(true);
  });

  test("a currency transfer is not, so it never becomes a collection", () => {
    const strk = getTokenBySymbol("STRK")!.address;
    expect(isNftTransferEvent({ ...nft, contractAddress: strk } as never)).toBe(false);
  });
});
