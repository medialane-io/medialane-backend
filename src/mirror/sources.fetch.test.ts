import { afterAll, expect, mock, test } from "bun:test";

const actual = await import("../utils/starknet.js");
afterAll(() => mock.module("../utils/starknet.js", () => actual));

function fakeRpc(getEvents: (req: { continuation_token?: string }) => Promise<unknown>) {
  mock.module("../utils/starknet.js", () => ({
    ...actual,
    callRpc: async (fn: (p: unknown) => Promise<unknown>) => fn({ getEvents }),
  }));
}

test("a source spanning more than 100 pages is read to the end", async () => {
  fakeRpc(async ({ continuation_token }) => {
    const page = Number(continuation_token ?? 0);
    return {
      events: [{ block_number: 1, keys: ["0x1"], data: [], transaction_hash: `0x${page}` }],
      continuation_token: page < 149 ? String(page + 1) : undefined,
    };
  });
  const { fetchDueSources, EVENT_SOURCES, CORE_MARKETPLACE_721 } = await import("./sources.js");
  const source = EVENT_SOURCES.find((s) => s.id === CORE_MARKETPLACE_721)!;

  const [fetch] = await fetchDueSources({ chain: "STARKNET", fromBlock: 1, toBlock: 2, now: 0, sources: [source] });

  expect(fetch.events).toHaveLength(150);
});

test("due sources are read at the same time and keep their order", async () => {
  let inFlight = 0;
  let peak = 0;
  fakeRpc(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return { events: [] };
  });
  const { fetchDueSources } = await import("./sources.js");
  const sources = ["a", "b", "c"].map((id) => ({
    id,
    scope: { kind: "contract" as const, address: `0x${id}` },
    selectors: ["0x1"],
  }));

  const fetches = await fetchDueSources({ chain: "STARKNET", fromBlock: 1, toBlock: 2, now: 0, sources });

  expect(fetches.map((f) => f.source.id)).toEqual(["a", "b", "c"]);
  expect(peak).toBeGreaterThan(1);
});
