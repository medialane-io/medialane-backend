import { test, expect } from "bun:test";
import { quoteRun } from "../../payments/launchpad.js";

test("a run is quoted as wallets and assets", async () => {
  const quote = await quoteRun("ip-club", 100);
  expect(quote.lines.map((l) => l.label)).toEqual([
    "Wallets for 100 people",
    "Assets for 100 people",
  ]);
});

test("a ticket run also pays for the ticket type", async () => {
  const quote = await quoteRun("ip-tickets", 10);
  expect(quote.lines[0]?.label).toBe("Ticket type");
  expect(quote.lines[0]?.units).toBe(1);
  expect(quote.lines).toHaveLength(3);
});

test("every line carries the action it is priced from, so spend history reads back", async () => {
  const keys = (await quoteRun("ip-tickets", 4)).lines.map((l) => l.actionKey);
  expect(keys).toEqual(["intent:create-tier", "wallet:deploy", "intent:mint"]);
});

test("a line costs its unit price times its count", async () => {
  for (const item of (await quoteRun("ip-club", 7)).lines) {
    expect(item.credits).toBe(item.unitCredits * item.units);
    expect(item.units).toBe(7);
  }
});

test("the total is the sum of the lines", async () => {
  const quote = await quoteRun("ip-tickets", 3);
  expect(quote.totalCredits).toBe(quote.lines.reduce((sum, l) => sum + l.credits, 0));
});

test("gas and storage are not quoted to the customer", async () => {
  const labels = (await quoteRun("ip-tickets", 3)).lines.map((l) => l.label).join(" ");
  for (const internal of ["gas", "IPFS", "transaction", "Prepare"]) {
    expect(labels).not.toContain(internal);
  }
});
