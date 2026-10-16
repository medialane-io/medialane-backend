import { afterAll, expect, mock, test } from "bun:test";

const actual = await import("../../utils/starknet.js");
afterAll(() => mock.module("../../utils/starknet.js", () => actual));

const FACTORY = "0x07421b4442f7f2052c65408fb3561484154cf8175a0bbb41e3cd38d9087af6d2";
const COLLECTION = "0x07fbf8fe556193c47aba0c80f280218dd3ca55bfcbbc159fa930b66603be49f3";
const OWNER = "0x0283e70573f8765763ffe6e0cbd74eec816cf195826443a96b64a50d7a4b9849";

test("a collection is looked up in the factory that announced it", async () => {
  const asked: string[] = [];
  mock.module("../../utils/starknet.js", () => ({
    ...actual,
    callRpc: async (fn: (p: unknown) => Promise<unknown>) =>
      fn({
        callContract: async ({ contractAddress }: { contractAddress: string }) => {
          asked.push(contractAddress);
          return ["0x0", "0x50696c6f74", "0x5", "0x0", "0x504c54", "0x3", "0x0", "0x0", "0x0", OWNER, COLLECTION];
        },
      }),
  }));
  const { resolveCollectionCreated } = await import("./collectionCreated.js");

  const resolved = await resolveCollectionCreated({
    type: "CollectionCreated",
    collectionId: "1",
    owner: OWNER,
    factoryAddress: FACTORY,
    blockNumber: 1n,
    txHash: "0x1",
    logIndex: 0,
  });

  expect(asked).toEqual([FACTORY]);
  expect(resolved?.contractAddress).toBe(actual.normalizeAddress("STARKNET", COLLECTION));
  expect(resolved?.name).toBe("Pilot");
});
