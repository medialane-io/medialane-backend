import { describe, expect, test } from "bun:test";
import { readArchived } from "./archived.js";

const call = (answer: string[] | Error) => async () => {
  if (answer instanceof Error) throw answer;
  return answer;
};

describe("readArchived", () => {
  test("reads the token's archived flag from the contract with its id as a u256", async () => {
    const seen: unknown[] = [];
    const archived = await readArchived({ contractAddress: "0x1", tokenId: "5" }, async (...args) => {
      seen.push(args);
      return ["0x1"];
    });
    expect(archived).toBe(true);
    expect(seen).toEqual([["0x1", "is_archived", ["5", "0"]]]);
  });

  test("a token that is not archived reads false", async () => {
    expect(await readArchived({ contractAddress: "0x1", tokenId: "5" }, call(["0x0"]))).toBe(false);
  });

  test("a transport failure throws instead of reading as not archived", async () => {
    await expect(readArchived({ contractAddress: "0x1", tokenId: "5" }, call(new Error("fetch failed")))).rejects.toThrow();
  });
});
