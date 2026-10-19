import { describe, expect, mock, test } from "bun:test";

mock.module("../../utils/collection.js", () => ({ ensureCollectionFromActivity: async () => {} }));

const { handleTransfer, EXTERNAL_TOKEN_LIMIT, EXTERNAL_TRANSFER_LIMIT } = await import("./transfer.js");

function fakeTx(opts: { service: string; tokenStored: boolean; storedTokens: number; oldestKeptBlock?: bigint }) {
  const writes: string[] = [];
  const tx = {
    collection: { findUnique: async () => ({ service: opts.service }) },
    token: {
      findUnique: async () => (opts.tokenStored ? { id: "t" } : null),
      count: async () => opts.storedTokens,
      upsert: async () => { writes.push("token"); return {}; },
    },
    transfer: {
      findMany: async () => (opts.oldestKeptBlock === undefined ? [] : [{ blockNumber: opts.oldestKeptBlock }]),
      findFirst: async () => null,
      create: async () => { writes.push("transfer"); return {}; },
    },
    $executeRaw: async (sql: TemplateStringsArray) => {
      writes.push(sql.join("").includes("DELETE") ? "prune" : "balance");
      return 1;
    },
  };
  return { tx, writes };
}

const transfer = (blockNumber = 10n) => ({
  type: "Transfer" as const,
  contractAddress: "0xc0",
  tokenId: "7",
  from: "0xa",
  to: "0xb",
  blockNumber,
  txHash: "0x1",
  logIndex: 0,
});

describe("external collection limits", () => {
  test("a new token of an external collection at the token limit is not stored", async () => {
    const { tx, writes } = fakeTx({ service: "external-erc721", tokenStored: false, storedTokens: EXTERNAL_TOKEN_LIMIT });
    await handleTransfer(transfer(), tx as never, "STARKNET");
    expect(writes).toEqual([]);
  });

  test("a stored token of an external collection keeps its transfers, trimmed to the latest", async () => {
    const { tx, writes } = fakeTx({ service: "external-erc721", tokenStored: true, storedTokens: EXTERNAL_TOKEN_LIMIT });
    await handleTransfer(transfer(), tx as never, "STARKNET");
    expect(writes).toEqual(["token", "transfer", "balance", "balance", "prune"]);
  });

  test("a transfer older than the kept window of an external collection is skipped", async () => {
    const { tx, writes } = fakeTx({ service: "external-erc721", tokenStored: true, storedTokens: 1, oldestKeptBlock: 50n });
    await handleTransfer(transfer(10n), tx as never, "STARKNET");
    expect(writes).toEqual([]);
  });

  test("a Medialane collection has no limits", async () => {
    const { tx, writes } = fakeTx({ service: "mip-erc721", tokenStored: false, storedTokens: EXTERNAL_TOKEN_LIMIT * 10 });
    await handleTransfer(transfer(), tx as never, "STARKNET");
    expect(writes).toEqual(["token", "transfer", "balance", "balance"]);
  });

  test("the limits are 100 tokens and 100 transfers", () => {
    expect(EXTERNAL_TOKEN_LIMIT).toBe(100);
    expect(EXTERNAL_TRANSFER_LIMIT).toBe(100);
  });
});
