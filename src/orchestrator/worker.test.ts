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

test("several items run at the same time", async () => {
  let inFlight = 0;
  let peak = 0;
  mock.module("../walletActivity/sync.js", () => ({
    syncWalletActivityProd: mock(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight--;
    }),
  }));
  const { worker } = await import("./worker.js");

  for (const a of ["0x1", "0x2", "0x3"]) {
    worker.enqueue({ type: "WALLET_ACTIVITY_SYNC", chain: "STARKNET", accountAddress: a });
  }
  await worker.waitDrain(2000);

  expect(peak).toBeGreaterThan(1);
});

test("a failing item does not hold up the items behind it", async () => {
  const calls: string[] = [];
  mock.module("../walletActivity/sync.js", () => ({
    syncWalletActivityProd: mock(async (_chain: string, address: string) => {
      calls.push(address);
      if (address === "0xbad") throw new Error("boom");
    }),
  }));
  const { worker } = await import("./worker.js");

  worker.enqueue({ type: "WALLET_ACTIVITY_SYNC", chain: "STARKNET", accountAddress: "0xbad" });
  worker.enqueue({ type: "WALLET_ACTIVITY_SYNC", chain: "STARKNET", accountAddress: "0xgood" });
  await new Promise((r) => setTimeout(r, 200));

  expect(calls).toContain("0xgood");
});
