import { describe, expect, test } from "bun:test";
import { parseFullTokenDataResult } from "./ipnft-onchain.js";

describe("parseFullTokenDataResult", () => {
  test("formats owner/creator as padded hex addresses and passes through uri/timestamp", () => {
    const raw: [unknown, unknown, unknown, unknown] = [
      0x1234n,
      "ipfs://bafy.../metadata.json",
      0x5678n,
      1700000000n,
    ];
    expect(parseFullTokenDataResult(raw)).toEqual({
      owner: "0x" + (0x1234n).toString(16).padStart(64, "0"),
      metadataUri: "ipfs://bafy.../metadata.json",
      originalCreator: "0x" + (0x5678n).toString(16).padStart(64, "0"),
      registeredAt: 1700000000,
    });
  });
});
