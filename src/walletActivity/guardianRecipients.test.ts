import { test, expect } from "bun:test";
import { guardianRecipients } from "./guardianRecipients.js";

const emails: Record<string, string | null> = { "acct-io": "ana@example.com", "acct-dapp": "ana@example.com", "acct-portal": "ops@business.com", "acct-none": null };
const emailOf = async (accountId: string) => emails[accountId] ?? null;

test("every account holding the wallet is told, once per email", async () => {
  expect(await guardianRecipients(["acct-io", "acct-dapp", "acct-portal"], emailOf)).toEqual(["ana@example.com", "ops@business.com"]);
});

test("an account with no email is skipped", async () => {
  expect(await guardianRecipients(["acct-none"], emailOf)).toEqual([]);
});
