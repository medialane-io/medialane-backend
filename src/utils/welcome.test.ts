import { test, expect } from "bun:test";
import { sendWelcomeIfDue, type WelcomeDeps, type WelcomeAccount } from "./welcome";
import { verifyConfirmToken } from "./emailConfirmToken";
import { verificationDeadline } from "../orchestrator/unverifiedAccounts";

const SECRET = "s".repeat(40);
const NOW = new Date("2026-10-03T12:00:00Z");
const ADDRESS = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const firstTry: WelcomeAccount = {
  status: "PENDING", createdAt: NOW, email: "alice@example.com", emailVerified: false, walletCount: 1,
};
const cameBackWithCode: WelcomeAccount = { ...firstTry, status: "ACTIVE", emailVerified: true };

function setup(account: WelcomeAccount | null = firstTry, overrides: Partial<WelcomeDeps> = {}) {
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

test("finishing onboarding on the first try welcomes the user and asks them to confirm", async () => {
  const { deps, sent, input } = setup();
  expect(await sendWelcomeIfDue(deps, input)).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toBe("alice@example.com");
  expect(sent[0]!.text).toContain(ADDRESS);
  expect(sent[0]!.text).toContain("confirm-email?token=");
});

test("the confirm link covers exactly that account and email, until the deadline", async () => {
  const { deps, sent, input } = setup();
  await sendWelcomeIfDue(deps, input);
  const url = sent[0]!.text.match(/https:\/\/www\.medialane\.io\/confirm-email\?token=(\S+)/)!;
  const claims = verifyConfirmToken(SECRET, decodeURIComponent(url[1]!), NOW);
  expect(claims?.accountId).toBe("acc_1");
  expect(claims?.email).toBe("alice@example.com");
  expect(claims?.expiresAt.getTime()).toBe(verificationDeadline(NOW).getTime());
});

test("finishing onboarding after coming back with a code still welcomes the user, without a confirm link", async () => {
  const { deps, sent, input } = setup(cameBackWithCode);
  expect(await sendWelcomeIfDue(deps, input)).toBe(true);
  expect(sent[0]!.subject).toBe("Welcome to Medialane");
  expect(sent[0]!.text).toContain(ADDRESS);
  expect(sent[0]!.text).not.toContain("confirm-email");
});

test("an existing user linking a second wallet is not welcomed again", async () => {
  const { deps, sent, input } = setup({ ...cameBackWithCode, walletCount: 2 });
  expect(await sendWelcomeIfDue(deps, input)).toBe(false);
  expect(sent).toHaveLength(0);
});

test("no email when the wallet was not newly linked", async () => {
  const { deps, sent, input } = setup();
  expect(await sendWelcomeIfDue(deps, { ...input, walletLinked: false })).toBe(false);
  expect(sent).toHaveLength(0);
});

test("no email for another client, or when no io client is configured", async () => {
  const a = setup();
  expect(await sendWelcomeIfDue(a.deps, { ...a.input, clientId: "client_OTHER" })).toBe(false);
  const b = setup(firstTry, { ioClientId: "" });
  expect(await sendWelcomeIfDue(b.deps, { ...b.input, clientId: "" })).toBe(false);
  expect(a.sent.length + b.sent.length).toBe(0);
});

test("no email for a closed account, one without an email, or a missing one", async () => {
  for (const account of [{ ...firstTry, status: "INACTIVE" as const }, { ...firstTry, email: null }, null]) {
    const { deps, sent, input } = setup(account);
    expect(await sendWelcomeIfDue(deps, input)).toBe(false);
    expect(sent).toHaveLength(0);
  }
});

test("an unverified account past its deadline is not sent a link that is already dead", async () => {
  const { deps, sent, input } = setup({ ...firstTry, createdAt: new Date("2026-09-20T12:00:00Z") });
  expect(await sendWelcomeIfDue(deps, input)).toBe(false);
  expect(sent).toHaveLength(0);
});

test("a send that fails is reported as false and does not throw", async () => {
  const { deps, input } = setup(firstTry, { send: async () => false });
  expect(await sendWelcomeIfDue(deps, input)).toBe(false);
});
