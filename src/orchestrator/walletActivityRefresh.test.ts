import { test, expect } from "bun:test";
import { runWalletActivityRefreshOnce } from "./walletActivityRefresh.js";

test("re-enqueues every account returned by findStaleActive", async () => {
  const enqueued: Array<{ chain: string; accountAddress: string }> = [];
  await runWalletActivityRefreshOnce({
    findStaleActive: async () => [
      { chain: "STARKNET", accountAddress: "0xabc" },
      { chain: "STARKNET", accountAddress: "0xdef" },
    ],
    enqueueSync: (chain, accountAddress) => { enqueued.push({ chain, accountAddress }); },
  });

  expect(enqueued).toHaveLength(2);
  expect(enqueued[0]).toMatchObject({ accountAddress: "0xabc" });
  expect(enqueued[1]).toMatchObject({ accountAddress: "0xdef" });
});

test("does nothing when nothing is stale", async () => {
  const enqueued: unknown[] = [];
  await runWalletActivityRefreshOnce({
    findStaleActive: async () => [],
    enqueueSync: () => { enqueued.push(true); },
  });

  expect(enqueued).toHaveLength(0);
});
