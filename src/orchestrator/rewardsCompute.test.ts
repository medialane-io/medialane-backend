import { describe, expect, test } from "bun:test";

describe("rewards compute interval default", () => {
  test("defaults to weekly — badges and XP are a full-history recompute, not something that needs per-day freshness", async () => {
    delete process.env.REWARDS_COMPUTE_INTERVAL_MS;
    const mod = await import(`./rewardsCompute.js?t=${Date.now()}`);
    expect(mod.REWARDS_COMPUTE_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
