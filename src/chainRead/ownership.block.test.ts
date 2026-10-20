import { describe, expect, test } from "bun:test";
import type { callRpc } from "../utils/starknet.js";
import { chainCallAt } from "./ownership.js";

/** An RPC whose provider records the block each call is read at. */
function recordingRpc(blocks: unknown[]): typeof callRpc {
  const provider = {
    callContract: async (_call: unknown, blockIdentifier?: unknown) => {
      blocks.push(blockIdentifier);
      return ["0xb"];
    },
  };
  return ((fn: (p: never) => Promise<unknown>) => fn(provider as never)) as typeof callRpc;
}

describe("which block ownership is read at", () => {
  test("a confirmed transaction's ownership is read at the pre-confirmed block", async () => {
    const blocks: unknown[] = [];
    await chainCallAt("pre_confirmed", recordingRpc(blocks))("0xc", "owner_of", ["1", "0"]);
    expect(blocks).toEqual(["pre_confirmed"]);
  });

  test("the indexer reads ownership at the latest block", async () => {
    const blocks: unknown[] = [];
    await chainCallAt("latest", recordingRpc(blocks))("0xc", "owner_of", ["1", "0"]);
    expect(blocks).toEqual(["latest"]);
  });
});
