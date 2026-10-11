import { expect, test } from "bun:test";
import { creditAccount, type CreditsDb } from "./credits.js";
import { assertWritable } from "../db/schema-fields.js";

test("a credit writes only fields the Payment table has", async () => {
  let written: Record<string, unknown> = {};
  const tx = {
    apiCredits: { update: async () => ({}) },
    payment: { create: async (args: { data: Record<string, unknown> }) => { written = args.data; return { id: "p1" }; } },
    creditEntry: { create: async () => ({ id: "e1" }) },
  } as unknown as CreditsDb;

  await creditAccount({
    apiCreditsId: "c1",
    accountId: "a1",
    amountAtomic: 1_000_000n,
    creditedAmount: 100,
    mdlnMultiplier: 1,
    scheme: "starknet-transfer",
    network: "starknet",
    asset: "0xusdc",
    txHash: "0xabc",
    proofNonce: "0xabc",
  }, tx);

  expect(() => assertWritable("Payment", written)).not.toThrow();
  expect(written.apiCreditsId).toBe("c1");
});
