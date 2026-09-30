import { expect, test } from "bun:test";
import { pendingPaths } from "./pending.js";

test("finds every reserved step, wherever it sits in a run's progress", () => {
  const progress = {
    collection: { tx: { status: "PENDING", at: "2026-09-30T12:00:00Z", credits: 6 } },
    wallets: { "ana@x.com": { status: "PENDING", at: "2026-09-30T12:00:00Z", credits: 6 }, "bo@x.com": "0xabc" },
    batches: { "0": { status: "PENDING", at: "2026-09-30T12:00:00Z", credits: 8 } },
  };
  expect(pendingPaths(progress)).toEqual([["collection", "tx"], ["wallets", "ana@x.com"], ["batches", "0"]]);
});

test("ignores steps that reached the chain, finished or reverted", () => {
  const progress = {
    batches: {
      "0": { status: "SUBMITTED", txHash: "0x1" },
      "1": { status: "SUCCEEDED", txHash: "0x2" },
      "2": { status: "REVERTED", txHash: "0x3" },
    },
    tokenUri: "ipfs://x",
  };
  expect(pendingPaths(progress)).toEqual([]);
});

test("copes with an empty or missing progress", () => {
  expect(pendingPaths(undefined)).toEqual([]);
  expect(pendingPaths({})).toEqual([]);
  expect(pendingPaths([])).toEqual([]);
});
