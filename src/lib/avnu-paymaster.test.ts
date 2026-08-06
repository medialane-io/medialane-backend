import { test, expect } from "bun:test";
import { isPaymasterConfigured, sponsorCalls } from "./avnu-paymaster.js";

test("isPaymasterConfigured is false with no API key set", () => {
  const original = process.env.AVNU_PAYMASTER_API_KEY;
  delete process.env.AVNU_PAYMASTER_API_KEY;
  expect(isPaymasterConfigured()).toBe(false);
  if (original) process.env.AVNU_PAYMASTER_API_KEY = original;
});

test("isPaymasterConfigured is true once the API key is set", () => {
  process.env.AVNU_PAYMASTER_API_KEY = "test-key";
  expect(isPaymasterConfigured()).toBe(true);
  delete process.env.AVNU_PAYMASTER_API_KEY;
});

test("sponsorCalls rejects when the paymaster isn't configured", async () => {
  delete process.env.AVNU_PAYMASTER_API_KEY;
  const fakeAccount = {} as never;
  await expect(sponsorCalls(fakeAccount, [])).rejects.toThrow(
    "AVNU_PAYMASTER_API_KEY is not set",
  );
});
