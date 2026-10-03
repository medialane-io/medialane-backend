import { test, expect } from "bun:test";
import { sendWelcomeIfDue, type WelcomeDeps, type WelcomeAccount } from "./welcome";
import { verifyConfirmToken } from "./emailConfirmToken";
import { verificationDeadline } from "../orchestrator/unverifiedAccounts";

const SECRET = "s".repeat(40);
const NOW = new Date("2026-10-03T12:00:00Z");
const ADDRESS = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const pending: WelcomeAccount = { status: "PENDING", createdAt: NOW, email: "alice@example.com", emailVerified: false };

function setup(account: WelcomeAccount | null = pending, overrides: Partial<WelcomeDeps> = {}) {
  const sent: Array<{ to: string; subject: string; html: string; text: string }> = [];
  const deps: WelcomeDeps = {
    loadAccount: async () => account,
    send: async (message) => { sent.push(message); return true; },
    secret: SECRET,
    ioClientId: "client_IO",
    appUrl: "https://www.medialane.io",
    now: () => NOW,
    ...overrides,
  };
  const input = { accountId: "acc_1", clientId: "client_IO", walletAddress: ADDRESS, walletLinked: true };
  return { deps, sent, input };
}

test("a newly linked wallet on a pending, unverified io account gets the welcome email once", async () => {
  const { deps, sent, input } = setup();
  expect(await sendWelcomeIfDue(deps, input)).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toBe("alice@example.com");
  expect(sent[0]!.text).toContain(ADDRESS);
});

test("the link in the email confirms exactly that account and email, until the deadline", async () => {
  const { deps, sent, input } = setup();
  await sendWelcomeIfDue(deps, input);
  const url = sent[0]!.text.match(/https:\/\/www\.medialane\.io\/confirm-email\?token=(\S+)/)!;
  const claims = verifyConfirmToken(SECRET, decodeURIComponent(url[1]!), NOW);
  expect(claims?.accountId).toBe("acc_1");
  expect(claims?.email).toBe("alice@example.com");
  expect(claims?.expiresAt.getTime()).toBe(verificationDeadline(NOW).getTime());
});

test("no email when the wallet was not newly linked", async () => {
  const { deps, sent, input } = setup();
  expect(await sendWelcomeIfDue(deps, { ...input, walletLinked: false })).toBe(false);
  expect(sent).toHaveLength(0);
});

test("no email for another client, or when no io client is configured", async () => {
  const a = setup();
  expect(await sendWelcomeIfDue(a.deps, { ...a.input, clientId: "client_OTHER" })).toBe(false);
  const b = setup(pending, { ioClientId: "" });
  expect(await sendWelcomeIfDue(b.deps, { ...b.input, clientId: "" })).toBe(false);
  expect(a.sent.length + b.sent.length).toBe(0);
});

test("no email for an account that is active, verified, without an email, or missing", async () => {
  for (const account of [
    { ...pending, status: "ACTIVE" as const },
    { ...pending, emailVerified: true },
    { ...pending, email: null },
    null,
  ]) {
    const { deps, sent, input } = setup(account);
    expect(await sendWelcomeIfDue(deps, input)).toBe(false);
    expect(sent).toHaveLength(0);
  }
});

test("no email when the deadline has already passed", async () => {
  const old = { ...pending, createdAt: new Date("2026-09-20T12:00:00Z") };
  const { deps, sent, input } = setup(old);
  expect(await sendWelcomeIfDue(deps, input)).toBe(false);
  expect(sent).toHaveLength(0);
});

test("a send that fails is reported as false and does not throw", async () => {
  const { deps, input } = setup(pending, { send: async () => false });
  expect(await sendWelcomeIfDue(deps, input)).toBe(false);
});
