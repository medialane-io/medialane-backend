import { expect, mock, test } from "bun:test";

let fetches = 0;
mock.module("./fetcher.js", () => ({
  fetchJson: async () => {
    fetches++;
    return null;
  },
}));

const { resolveMetadata } = await import("./index.js");

test("a file no gateway could serve is not fetched again on the next view", async () => {
  const uri = `ipfs://QmFailureCache${Date.now()}`;
  expect(await resolveMetadata(uri)).toBeNull();
  const afterFirst = fetches;
  expect(afterFirst).toBeGreaterThan(0);
  expect(await resolveMetadata(uri)).toBeNull();
  expect(fetches).toBe(afterFirst);
});
