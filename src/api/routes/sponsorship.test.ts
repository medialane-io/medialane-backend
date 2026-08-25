import { describe, expect, test } from "bun:test";
import { resolveOwnedPairs, resolveHolderTokenIds, MAX_OWNED_TOKEN_LOOKUP } from "./sponsorship.js";

function fakeDb(seenTake: { value?: number }) {
  return {
    tokenBalance: {
      async findMany(args: { take?: number }) {
        seenTake.value = args.take;
        return [];
      },
    },
  } as never;
}

describe("resolveOwnedPairs", () => {
  test("caps the lookup — an owner's lifetime holdings are unbounded and grow with usage, not traffic", async () => {
    const seenTake: { value?: number } = {};
    await resolveOwnedPairs("STARKNET", "0x1", fakeDb(seenTake));
    expect(seenTake.value).toBe(MAX_OWNED_TOKEN_LOOKUP);
  });

  test("returns undefined when no owner is given, without querying the db", async () => {
    let called = false;
    const db = {
      tokenBalance: {
        async findMany() {
          called = true;
          return [];
        },
      },
    } as never;
    const result = await resolveOwnedPairs("STARKNET", undefined, db);
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe("resolveHolderTokenIds", () => {
  test("caps the lookup — same unbounded-by-usage shape as resolveOwnedPairs", async () => {
    const seenTake: { value?: number } = {};
    await resolveHolderTokenIds("STARKNET", "0x1", fakeDb(seenTake));
    expect(seenTake.value).toBe(MAX_OWNED_TOKEN_LOOKUP);
  });
});
