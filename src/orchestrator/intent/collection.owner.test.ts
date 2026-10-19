import { expect, mock, test } from "bun:test";

const real = await import("../../utils/starknet.js");
mock.module("../../utils/starknet.js", () => ({ ...real, callRpc: async () => ["0x0"] }));

const { buildMintIntent } = await import("./collection.js");
const { IntentRefusal } = await import("./refusal.js");

test("minting into a collection the wallet does not own is refused with a reason", async () => {
  const err = await buildMintIntent({
    owner: "0x01",
    recipient: "0x01",
    collectionId: "24",
    tokenUri: "ipfs://x",
  } as never).catch((e) => e);
  expect(err).toBeInstanceOf(IntentRefusal);
  expect(err.reason).toBe("This collection belongs to another account. Choose one of your collections and try again.");
});
