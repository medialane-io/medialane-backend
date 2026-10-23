import { describe, expect, test } from "bun:test";
import { normalizeAddress } from "@medialane/sdk";
import { ZERO_ADDRESS } from "../config/constants.js";
import type { ParsedEvent } from "../types/marketplace.js";
import { ownershipKeys, readOwnership } from "./ownership.js";
import type { CallContract } from "./call.js";

const A = normalizeAddress("STARKNET", "0xa");
const B = normalizeAddress("STARKNET", "0xb");
const C = "0xc";

const base = { blockNumber: 1n, txHash: "0x1", logIndex: 0 };
const transfer = (from: string, to: string, tokenId: string): ParsedEvent =>
  ({ type: "Transfer", contractAddress: C, from, to, tokenId, ...base });
const single = (from: string, to: string, tokenId: string, amount = "1"): ParsedEvent =>
  ({ type: "TransferSingle", contractAddress: C, operator: from, from, to, tokenId, amount, ...base });

const contractError = (code: number) => Object.assign(new Error("contract error"), { code });

/** A chain that answers from a table keyed by entrypoint; a function entry may throw. */
function fakeChain(answers: Record<string, (calldata: string[]) => string[]>) {
  const calls: Array<{ entrypoint: string; calldata: string[] }> = [];
  const call: CallContract = async (_contract, entrypoint, calldata) => {
    calls.push({ entrypoint, calldata });
    const answer = answers[entrypoint];
    if (!answer) throw contractError(21);
    return answer(calldata);
  };
  return { call, calls };
}

describe("ownershipKeys", () => {
  test("an erc721 transfer yields one key per token, read once however often it moved", () => {
    expect(ownershipKeys([transfer(ZERO_ADDRESS, A, "1"), transfer(A, B, "1")])).toEqual([
      { standard: "ERC721", contractAddress: C, tokenId: "1" },
    ]);
  });

  test("an erc1155 transfer yields keys for sender and receiver, never the zero address", () => {
    expect(ownershipKeys([single(ZERO_ADDRESS, A, "1", "5"), single(A, B, "1", "2")])).toEqual([
      { standard: "ERC1155", contractAddress: C, tokenId: "1", owner: A },
      { standard: "ERC1155", contractAddress: C, tokenId: "1", owner: B },
    ]);
  });

  test("a batch transfer yields a key per token id", () => {
    const batch: ParsedEvent = {
      type: "TransferBatch", contractAddress: C, operator: A, from: A, to: B,
      transfers: [{ tokenId: "1", amount: "1" }, { tokenId: "2", amount: "3" }], ...base,
    };
    expect(ownershipKeys([batch])).toEqual([
      { standard: "ERC1155", contractAddress: C, tokenId: "1", owner: A },
      { standard: "ERC1155", contractAddress: C, tokenId: "1", owner: B },
      { standard: "ERC1155", contractAddress: C, tokenId: "2", owner: A },
      { standard: "ERC1155", contractAddress: C, tokenId: "2", owner: B },
    ]);
  });

  test("events that are not transfers yield nothing", () => {
    const counter = { type: "CounterIncremented", offerer: A, newCounter: "1", ...base } as unknown as ParsedEvent;
    expect(ownershipKeys([counter])).toEqual([]);
  });
});

describe("readOwnership", () => {
  test("an erc721 owner is read with owner_of", async () => {
    const { call, calls } = fakeChain({ owner_of: () => ["0xb"] });
    const facts = await readOwnership([{ standard: "ERC721", contractAddress: C, tokenId: "7" }], call);
    expect(facts).toEqual([{ standard: "ERC721", contractAddress: C, tokenId: "7", owner: B }]);
    expect(calls).toEqual([{ entrypoint: "owner_of", calldata: ["7", "0"] }]);
  });

  test("ownerOf is used when owner_of does not exist", async () => {
    const { call } = fakeChain({ ownerOf: () => ["0xb"] });
    const facts = await readOwnership([{ standard: "ERC721", contractAddress: C, tokenId: "7" }], call);
    expect(facts).toEqual([{ standard: "ERC721", contractAddress: C, tokenId: "7", owner: B }]);
  });

  test("a token whose owner reads revert has no owner", async () => {
    const revert = () => { throw contractError(40); };
    const { call } = fakeChain({ owner_of: revert, ownerOf: revert });
    const facts = await readOwnership([{ standard: "ERC721", contractAddress: C, tokenId: "7" }], call);
    expect(facts).toEqual([{ standard: "ERC721", contractAddress: C, tokenId: "7", owner: null }]);
  });

  test("an erc1155 amount is read with balance_of(account, id)", async () => {
    const { call, calls } = fakeChain({ balance_of: () => ["0x5", "0x0"] });
    const facts = await readOwnership([{ standard: "ERC1155", contractAddress: C, tokenId: "3", owner: A }], call);
    expect(facts).toEqual([{ standard: "ERC1155", contractAddress: C, tokenId: "3", owner: A, amount: 5n }]);
    expect(calls).toEqual([{ entrypoint: "balance_of", calldata: [A, "3", "0"] }]);
  });

  test("an erc1155 read that reverts counts as zero", async () => {
    const revert = () => { throw contractError(40); };
    const { call } = fakeChain({ balance_of: revert, balanceOf: revert });
    const facts = await readOwnership([{ standard: "ERC1155", contractAddress: C, tokenId: "3", owner: A }], call);
    expect(facts).toEqual([{ standard: "ERC1155", contractAddress: C, tokenId: "3", owner: A, amount: 0n }]);
  });

  test("a transport failure is thrown, not treated as no owner", async () => {
    const { call } = fakeChain({ owner_of: () => { throw new Error("fetch failed"); } });
    await expect(readOwnership([{ standard: "ERC721", contractAddress: C, tokenId: "7" }], call)).rejects.toThrow("fetch failed");
  });
});
