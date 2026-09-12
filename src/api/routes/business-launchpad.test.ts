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
  expect(quote.lines).toHaveLength(3);
});

test("the total is carried in USDC atomic units, not credits", async () => {
  const quote = await quoteRun("ip-club", 1);
  expect(BigInt(quote.totalAtomic)).toBe(BigInt(quote.totalCredits) * 10_000n);
});

test("gas and storage are not quoted to the customer", async () => {
  const labels = (await quoteRun("ip-tickets", 3)).lines.map((l) => l.label).join(" ");
  for (const internal of ["gas", "IPFS", "transaction", "Prepare"]) {
    expect(labels).not.toContain(internal);
  }
});
