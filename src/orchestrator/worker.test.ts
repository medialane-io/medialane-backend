import { test, expect, mock } from "bun:test";

test("WALLET_ACTIVITY_SYNC item is deduplicated by chain+accountAddress", async () => {
  mock.module("../walletActivity/sync.js", () => ({
    syncWalletActivityProd: mock(() => Promise.resolve()),
  }));
  const { worker } = await import("./worker.js");
  const { syncWalletActivityProd } = await import("../walletActivity/sync.js");

  worker.enqueue({ type: "WALLET_ACTIVITY_SYNC", chain: "STARKNET", accountAddress: "0xabc" });
  worker.enqueue({ type: "WALLET_ACTIVITY_SYNC", chain: "STARKNET", accountAddress: "0xabc" });
  await worker.waitDrain(2000);

  expect(syncWalletActivityProd).toHaveBeenCalledTimes(1);
});
