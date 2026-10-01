import { describe, expect, mock, test } from "bun:test";
import { normalizeAddress } from "@medialane/sdk";

mock.module("../../utils/collection.js", () => ({
  resolveServiceForContract: async (_db: unknown, _chain: string, _contractAddress: string) => "pop-protocol",
}));

const { buildMintIntent } = await import("./collection.js");

describe("buildMintIntent for a pop-protocol collection", () => {
  test("calls admin_mint with an empty custom_uri by default", async () => {
    const result = await buildMintIntent({
      owner: "0x01",
      recipient: "0x02",
      collectionContract: "0x03",
    } as never);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].entrypoint).toBe("admin_mint");
    expect(result.calls[0].contractAddress).toBe(normalizeAddress("STARKNET", "0x03"));
  });

  test("passes a custom_uri through when one is given", async () => {
    const result = await buildMintIntent({
      owner: "0x01",
      recipient: "0x02",
      collectionContract: "0x03",
      customUri: "ipfs://distinction",
    } as never);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].entrypoint).toBe("admin_mint");
  });
});
