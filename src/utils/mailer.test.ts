import { afterEach, describe, test, expect } from "bun:test";
import {
  relayChannel,
  sanitizeFromName,
  sendEmail,
  sendVerificationCode,
  sendGuardianSetEmail,
  sendGuardianEscapeTriggeredEmail,
  sendGuardianEscapeCompletedEmail,
  type EmailChannel,
  type EmailMessage,
} from "./mailer";
import { env } from "../config/env";

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

test("an email not tied to an app, like a guardian alert, is sent as Medialane", async () => {
  const { fromNameForClient } = await import("./mailer");
  expect(await fromNameForClient(null)).toBe("Medialane");
});

const message: EmailMessage = { to: "a@b.co", template: "verification-code", data: { code: "482913" } };
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

describe("the relay channel", () => {
  const realFetch = globalThis.fetch;
  const saved = { url: env.MAIL_RELAY_URL, secret: env.MAIL_RELAY_SECRET };
  afterEach(() => {
    globalThis.fetch = realFetch;
    env.MAIL_RELAY_URL = saved.url;
    env.MAIL_RELAY_SECRET = saved.secret;
  });

  test("sends the template and its data, with the secret, and never any html", async () => {
    env.MAIL_RELAY_URL = "https://relay.example";
    env.MAIL_RELAY_SECRET = "s3cret";
    let seen: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    expect(await relayChannel({ ...message, fromName: "Acme" })).toBe(true);
    expect(seen!.url).toBe("https://relay.example/api/internal/send-email");
    expect((seen!.init.headers as Record<string, string>)["x-relay-secret"]).toBe("s3cret");
    const body = JSON.parse(seen!.init.body as string);
    expect(body).toEqual({ to: "a@b.co", fromName: "Acme", template: "verification-code", data: { code: "482913" } });
  });

  test("is not configured without a url and secret", async () => {
    env.MAIL_RELAY_URL = "";
    env.MAIL_RELAY_SECRET = "";
    expect(await relayChannel(message)).toBe(false);
  });

  test("a refusal from the relay is an error, so the send is reported as failed", async () => {
    env.MAIL_RELAY_URL = "https://relay.example";
    env.MAIL_RELAY_SECRET = "s3cret";
    globalThis.fetch = (async () => new Response("no", { status: 400 })) as unknown as typeof fetch;
    await expect(relayChannel(message)).rejects.toThrow("400");
  });
});

describe("the verification code email", () => {
  test("is sent to the person, under the sender name of the app that asked for it", async () => {
    const sent: EmailMessage[] = [];
    const deps = {
      send: async (m: EmailMessage) => (sent.push(m), true),
      fromNameFor: async (clientId: string | null) => (clientId === "client_ACME" ? "Acme Studios" : "Medialane"),
    };
    await sendVerificationCode("a@b.co", "482913", "client_ACME", deps);
    await sendVerificationCode("c@d.co", "111111", null, deps);
    expect(sent.map((m) => [m.to, m.fromName])).toEqual([["a@b.co", "Acme Studios"], ["c@d.co", "Medialane"]]);
    expect(sent[0]).toMatchObject({ template: "verification-code", data: { code: "482913" } });
  });

  test("a failed send does not throw, so signing in never breaks on the mail provider", async () => {
    const deps = { send: async () => false, fromNameFor: async () => "Medialane" };
    await expect(sendVerificationCode("a@b.co", "482913", null, deps)).resolves.toBeUndefined();
  });
});

describe("the guardian security alerts", () => {
  const ADDRESS = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const readyAt = new Date("2026-10-10T12:00:00Z");

  test("go out through the same path as every other email, as templates", async () => {
    const sent: EmailMessage[] = [];
    const send = async (m: EmailMessage) => (sent.push(m), true);
    await sendGuardianSetEmail("a@b.co", ADDRESS, send);
    await sendGuardianEscapeTriggeredEmail("a@b.co", ADDRESS, readyAt, send);
    await sendGuardianEscapeCompletedEmail("a@b.co", ADDRESS, send);
    expect(sent).toEqual([
      { to: "a@b.co", template: "guardian-set", data: { walletAddress: ADDRESS } },
      { to: "a@b.co", template: "guardian-escape-triggered", data: { walletAddress: ADDRESS, readyAt } },
      { to: "a@b.co", template: "guardian-escape-completed", data: { walletAddress: ADDRESS } },
    ]);
  });

  test("a failed send does not throw, so the wallet sync carries on", async () => {
    await expect(sendGuardianSetEmail("a@b.co", ADDRESS, async () => false)).resolves.toBeUndefined();
  });
});
