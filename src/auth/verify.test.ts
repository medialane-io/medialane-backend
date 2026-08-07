import { test, expect } from "bun:test";
import { verifyStarknetWithRetry } from "./verify";

test("verifyStarknetWithRetry returns ok:true immediately when the attempt succeeds", async () => {
  const result = await verifyStarknetWithRetry(async () => true, { sleep: async () => {} });
  expect(result).toEqual({ ok: true });
});

test("verifyStarknetWithRetry returns invalid immediately on a genuine bad signature (no retry)", async () => {
  let calls = 0;
  const result = await verifyStarknetWithRetry(
    async () => { calls++; return false; },
    { sleep: async () => {} },
  );
  expect(result).toEqual({ ok: false, reason: "invalid" });
  expect(calls).toBe(1);
});

test("verifyStarknetWithRetry retries on 'Contract not found' and succeeds once the deploy has propagated", async () => {
  let calls = 0;
  const result = await verifyStarknetWithRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("Contract not found");
      return true;
    },
    { retries: 3, sleep: async () => {} },
  );
  expect(result).toEqual({ ok: true });
  expect(calls).toBe(3);
});

test("verifyStarknetWithRetry gives up as not_deployed after exhausting retries", async () => {
  let calls = 0;
  const result = await verifyStarknetWithRetry(
    async () => { calls++; throw new Error("Contract not found"); },
    { retries: 2, sleep: async () => {} },
  );
  expect(result).toEqual({ ok: false, reason: "not_deployed" });
  expect(calls).toBe(3); // initial attempt + 2 retries
});

test("verifyStarknetWithRetry re-throws unexpected RPC errors without retrying", async () => {
  let calls = 0;
  await expect(
    verifyStarknetWithRetry(
      async () => { calls++; throw new Error("RPC: some other failure"); },
      { sleep: async () => {} },
    ),
  ).rejects.toThrow("RPC: some other failure");
  expect(calls).toBe(1);
});

test("verifyStarknetWithRetry waits between retries using the provided sleep", async () => {
  const delays: number[] = [];
  let calls = 0;
  await verifyStarknetWithRetry(
    async () => {
      calls++;
      if (calls < 2) throw new Error("Contract not found");
      return true;
    },
    { retries: 3, delayMs: 1500, sleep: async (ms) => { delays.push(ms); } },
  );
  expect(delays).toEqual([1500]);
});
