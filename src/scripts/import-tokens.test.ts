import { describe, expect, test } from "bun:test";
import { num, hash } from "starknet";
import { isDroppedConnection, mintedTokenIds, ownedFacts, ownershipToWrite, retryOnDroppedConnection } from "./import-tokens.js";
import type { RawStarknetEvent } from "../types/starknet.js";

const C = "0xc";
const SEL = num.toHex(hash.getSelectorFromName("Transfer"));
let tx = 0;
const transfer = (from: string, to: string, tokenId: number): RawStarknetEvent => ({
  block_hash: "0x1",
  block_number: 1,
  transaction_hash: num.toHex(++tx),
  from_address: C,
  keys: [SEL, from, to, num.toHex(tokenId), "0x0"],
  data: [],
});
const erc721 = (tokenId: string, owner: string | null) =>
  ({ standard: "ERC721" as const, contractAddress: C, tokenId, owner });

describe("token ids minted by a collection", () => {
  test("only transfers from the zero address count as mints", () => {
    expect(mintedTokenIds([transfer("0x0", "0xa", 1), transfer("0xa", "0xb", 1), transfer("0x0", "0xb", 2)]))
      .toEqual(["1", "2"]);
  });

  test("ids are unique and in numeric order", () => {
    expect(mintedTokenIds([transfer("0x0", "0xa", 10), transfer("0x0", "0xa", 9), transfer("0x0", "0xa", 10)]))
      .toEqual(["9", "10"]);
  });
});

describe("tokens kept for import", () => {
  test("tokens with no owner are left out", () => {
    expect(ownedFacts([erc721("1", "0xa"), erc721("2", null)])).toEqual([erc721("1", "0xa")]);
  });
});

describe("writes repeated when the database connection drops", () => {
  const fast = { attempts: 3, delayMs: 0, reconnect: async () => {} };
  const dropped = Object.assign(new Error("Server has closed the connection."), { code: "P1017" });

  test("dropped connections are recognised, other errors are not", () => {
    expect(isDroppedConnection(dropped)).toBe(true);
    expect(isDroppedConnection({ code: "P2028", message: "Transaction already closed" })).toBe(true);
    expect(isDroppedConnection(new Error("Invalid invocation: Server has closed the connection."))).toBe(true);
    expect(isDroppedConnection(Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" }))).toBe(false);
    expect(isDroppedConnection(null)).toBe(false);
  });

  test("a write that hits a dropped connection is repeated until it succeeds", async () => {
    let calls = 0;
    const result = await retryOnDroppedConnection(async () => {
      calls++;
      if (calls < 3) throw dropped;
      return "written";
    }, fast);
    expect(result).toBe("written");
    expect(calls).toBe(3);
  });

  test("the last dropped connection is thrown once the attempts run out", async () => {
    let calls = 0;
    await expect(retryOnDroppedConnection(async () => { calls++; throw dropped; }, fast)).rejects.toBe(dropped);
    expect(calls).toBe(3);
  });

  test("any other error is thrown without repeating the write", async () => {
    let calls = 0;
    const refused = Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" });
    await expect(retryOnDroppedConnection(async () => { calls++; throw refused; }, fast)).rejects.toBe(refused);
    expect(calls).toBe(1);
  });
});

describe("only new or changed owners are written", () => {
  const stored = (tokenId: string, owner: string, amount = "1") => ({ tokenId, owner, amount });

  test("a token already stored with the same owner is skipped", () => {
    expect(ownershipToWrite([erc721("1", "0xa")], [stored("1", "0xa")])).toEqual({ missing: [], changed: [] });
  });

  test("a token with no stored owner is written as new", () => {
    expect(ownershipToWrite([erc721("1", "0xa")], [])).toEqual({ missing: [{ tokenId: "1", owner: "0xa" }], changed: [] });
  });

  test("a token stored with another owner, extra rows or another amount is rewritten", () => {
    const facts = [erc721("1", "0xa"), erc721("2", "0xa"), erc721("3", "0xa")];
    const rows = [stored("1", "0xb"), stored("2", "0xa"), stored("2", "0xc"), stored("3", "0xa", "2")];
    expect(ownershipToWrite(facts, rows)).toEqual({ missing: [], changed: facts });
  });
});

describe("a write that hangs", () => {
  test("times out, reconnects and is retried", async () => {
    let calls = 0;
    let reconnects = 0;
    const result = await retryOnDroppedConnection(
      () => {
        calls++;
        return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve("written");
      },
      { attempts: 3, delayMs: 0, timeoutMs: 20, reconnect: async () => { reconnects++; } },
    );
    expect(result).toBe("written");
    expect(calls).toBe(2);
    expect(reconnects).toBe(1);
  });
});
