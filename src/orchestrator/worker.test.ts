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

test("while every RPC endpoint is cooling down the worker waits, then runs the queue", async () => {
  const { InMemoryWorker } = await import("./worker.js");
  let wait = 60;
  const started: number[] = [];
  const t0 = Date.now();
  const w = new InMemoryWorker(() => wait, async () => { started.push(Date.now() - t0); });
  setTimeout(() => { wait = 0; }, 50);
  w.enqueue({ type: "WALLET_ACTIVITY_SYNC", chain: "STARKNET", accountAddress: "0xwait" });
  await w.waitDrain(2000);
  expect(started).toHaveLength(1);
  expect(started[0]!).toBeGreaterThanOrEqual(50);
});

test("with an endpoint ready the worker starts at once", async () => {
  const { InMemoryWorker } = await import("./worker.js");
  const started: string[] = [];
  const w = new InMemoryWorker(() => 0, async (item) => { if (item.type === "WALLET_ACTIVITY_SYNC") started.push(item.accountAddress); });
  w.enqueue({ type: "WALLET_ACTIVITY_SYNC", chain: "STARKNET", accountAddress: "0xnow" });
  await w.waitDrain(500);
  expect(started).toEqual(["0xnow"]);
});
