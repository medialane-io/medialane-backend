import { expect, test } from "bun:test";
import { PRICING } from "../../pricing.config.js";
import { creditsForAction, pricingTable } from "./pricing.js";

test("every price in pricing.config.js is advertised, in credits at 1 credit = $0.01", async () => {
  const { rules } = await pricingTable();
  expect(rules).toHaveLength(PRICING.length);
  for (const row of PRICING) {
    const rule = rules.find((r) => r.actionKey === row.action && r.chain === (row.chain ?? "ALL") && r.service === (row.service ?? "ALL"));
    expect(rule?.credits).toBe(Math.round(row.usd / 0.01));
  }
});

test("an action is charged its configured price", async () => {
  const read = PRICING.find((row) => row.action === "read" && !row.chain && !row.service)!;
  expect(await creditsForAction("read")).toBe(Math.round(read.usd / 0.01));
});
