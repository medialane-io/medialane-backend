import { describe, expect, mock, test } from "bun:test";
import { ZERO_ADDRESS } from "../../config/constants.js";

mock.module("../../utils/collection.js", () => ({ ensureCollectionFromActivity: async () => {} }));

const { handleTransfer } = await import("./transfer.js");

/** Records which owners each balance statement touches. */
function fakeTx() {
  const owners: string[] = [];
  const tx = {
    token: { upsert: async () => ({}) },
    transfer: { findFirst: async () => null, create: async () => ({}) },
    $executeRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      owners.push(String(values[3]));
      return 1;
    },
  };
  return { tx, owners };
}

const transfer = (from: string, to: string) => ({
  type: "Transfer" as const,
  contractAddress: "0xc0",
  tokenId: "1",
  from,
  to,
  blockNumber: 1n,
  txHash: "0x1",
  logIndex: 0,
});

describe("ERC-721 balances", () => {
  test("a burn takes the token from its holder and credits nobody", async () => {
    const { tx, owners } = fakeTx();
    await handleTransfer(transfer("0xa", ZERO_ADDRESS), tx as never, "STARKNET");
    expect(owners).toEqual(["0xa"]);
  });

  test("a mint credits the recipient and debits nobody", async () => {
    const { tx, owners } = fakeTx();
    await handleTransfer(transfer(ZERO_ADDRESS, "0xb"), tx as never, "STARKNET");
    expect(owners).toEqual(["0xb"]);
  });
});
