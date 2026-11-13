import { afterEach, expect, test } from "bun:test";
import { resolveMetadata } from "./index.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("a file no gateway could serve is not fetched again on the next view", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response("missing", { status: 404 });
  }) as unknown as typeof fetch;
  const uri = `ipfs://QmFailureCache${Date.now()}`;
  expect(await resolveMetadata(uri)).toBeNull();
  const afterFirst = fetches;
  expect(afterFirst).toBeGreaterThan(0);
  expect(await resolveMetadata(uri)).toBeNull();
  expect(fetches).toBe(afterFirst);
});
