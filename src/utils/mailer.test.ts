import { describe, test, expect } from "bun:test";
import {
  buildVerificationCodeEmailHtml,
  buildGuardianEscapeTriggeredEmailHtml,
  buildGuardianSetEmailHtml,
  buildGuardianEscapeCompletedEmailHtml,
  sanitizeFromName,
  sendEmail,
  buildVerificationCodeEmail,
  sendVerificationCode,
  sendGuardianSetEmail,
  sendGuardianEscapeTriggeredEmail,
  sendGuardianEscapeCompletedEmail,
  type EmailChannel,
  type EmailMessage,
} from "./mailer";

test("sanitizeFromName keeps an ordinary brand name", () => {
  expect(sanitizeFromName("Acme Studios")).toBe("Acme Studios");
  expect(sanitizeFromName("Café & Co.")).toBe("Café & Co.");
});

test("sanitizeFromName strips markup, quotes and line breaks and caps the length", () => {
  expect(sanitizeFromName('Bank <security@x.com>\r\nBcc: a@b.c')).not.toMatch(/[<>@:\r\n]/);
  expect(sanitizeFromName("x".repeat(100)).length).toBeLessThanOrEqual(40);
});

test("sanitizeFromName falls back to Medialane when nothing usable is left", () => {
  expect(sanitizeFromName(null)).toBe("Medialane");
  expect(sanitizeFromName("   ")).toBe("Medialane");
  expect(sanitizeFromName("<<>>")).toBe("Medialane");
});

const ADDRESS = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("buildVerificationCodeEmailHtml includes the code", () => {
  const html = buildVerificationCodeEmailHtml("482913");
  expect(html).toContain("482913");
});

test("buildVerificationCodeEmailHtml does not leak other codes", () => {
  const html = buildVerificationCodeEmailHtml("111111");
  expect(html).not.toContain("482913");
});

test("buildGuardianEscapeTriggeredEmailHtml shows a shortened address and the ready time", () => {
  const readyAt = new Date("2026-10-05T12:00:00.000Z");
  const html = buildGuardianEscapeTriggeredEmailHtml(ADDRESS, readyAt);
  expect(html).toContain("0x0123…cdef");
  expect(html).not.toContain(ADDRESS);
  expect(html).toContain(readyAt.toUTCString());
});

test("buildGuardianSetEmailHtml shows a shortened address, not the full one", () => {
  const html = buildGuardianSetEmailHtml(ADDRESS);
  expect(html).toContain("0x0123…cdef");
  expect(html).not.toContain(ADDRESS);
  expect(html).toContain("guardian was added");
});

test("buildGuardianEscapeCompletedEmailHtml shows a shortened address, not the full one", () => {
  const html = buildGuardianEscapeCompletedEmailHtml(ADDRESS);
  expect(html).toContain("0x0123…cdef");
  expect(html).not.toContain(ADDRESS);
  expect(html).toContain("owner key was just replaced");
});

test("an email not tied to an app, like a guardian alert, is sent as Medialane", async () => {
  const { fromNameForClient } = await import("./mailer");
  expect(await fromNameForClient(null)).toBe("Medialane");
});

const message: EmailMessage = { to: "a@b.co", subject: "s", html: "<p>h</p>", text: "t" };
const delivers: EmailChannel = async () => true;
const notConfigured: EmailChannel = async () => false;
const fails: EmailChannel = async () => { throw new Error("down"); };

test("sendEmail stops at the first channel that delivers", async () => {
  const seen: string[] = [];
  const first: EmailChannel = async () => { seen.push("first"); return true; };
  const second: EmailChannel = async () => { seen.push("second"); return true; };
  expect(await sendEmail(message, [first, second])).toBe(true);
  expect(seen).toEqual(["first"]);
});

test("sendEmail moves on when a channel is not configured or fails", async () => {
  expect(await sendEmail(message, [notConfigured, delivers])).toBe(true);
  expect(await sendEmail(message, [fails, delivers])).toBe(true);
});

test("sendEmail reports false, and does not throw, when nothing delivered", async () => {
  expect(await sendEmail(message, [notConfigured, fails])).toBe(false);
  expect(await sendEmail(message, [])).toBe(false);
});

describe("the verification code email", () => {
  test("has the same subject as before and carries the code and its lifetime in both parts", () => {
    const { subject, html, text } = buildVerificationCodeEmail("482913");
    expect(subject).toBe("Your verification code");
    for (const body of [html, text]) {
      expect(body).toContain("482913");
      expect(body).toContain("10 minutes");
    }
    expect(text).toContain("If you didn't request this");
  });

  test("is sent to the person, under the sender name of the app that asked for it", async () => {
    const sent: EmailMessage[] = [];
    const deps = {
      send: async (m: EmailMessage) => (sent.push(m), true),
      fromNameFor: async (clientId: string | null) => (clientId === "client_ACME" ? "Acme Studios" : "Medialane"),
    };
    await sendVerificationCode("a@b.co", "482913", "client_ACME", deps);
    await sendVerificationCode("c@d.co", "111111", null, deps);
    expect(sent.map((m) => [m.to, m.fromName])).toEqual([["a@b.co", "Acme Studios"], ["c@d.co", "Medialane"]]);
    expect(sent[0]!.text).toContain("482913");
  });

  test("a failed send does not throw, so signing in never breaks on the mail provider", async () => {
    const deps = { send: async () => false, fromNameFor: async () => "Medialane" };
    await expect(sendVerificationCode("a@b.co", "482913", null, deps)).resolves.toBeUndefined();
  });
});

describe("the guardian security alerts", () => {
  const ADDRESS = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("go out through the same path as every other email, with a plain-text part", async () => {
    const sent: EmailMessage[] = [];
    const send = async (m: EmailMessage) => (sent.push(m), true);
    await sendGuardianSetEmail("a@b.co", ADDRESS, send);
    await sendGuardianEscapeTriggeredEmail("a@b.co", ADDRESS, new Date("2026-10-10T12:00:00Z"), send);
    await sendGuardianEscapeCompletedEmail("a@b.co", ADDRESS, send);
    expect(sent).toHaveLength(3);
    for (const m of sent) {
      expect(m.to).toBe("a@b.co");
      expect(m.subject.length).toBeGreaterThan(0);
      expect(m.html).toContain("0x0123");
      expect(m.text.length).toBeGreaterThan(20);
      expect(m.text).not.toContain("<");
    }
  });

  test("a failed send does not throw, so the wallet sync carries on", async () => {
    await expect(sendGuardianSetEmail("a@b.co", ADDRESS, async () => false)).resolves.toBeUndefined();
  });
});
