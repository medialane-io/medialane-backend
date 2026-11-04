import { afterEach, describe, test, expect } from "bun:test";
import {
  sendFailure,
  zeptoMailChannel,
  sanitizeFromName,
  sendEmail,
  sendVerificationCode,
  sendGuardianSetEmail,
  sendGuardianEscapeTriggeredEmail,
  sendGuardianEscapeCompletedEmail,
  type EmailChannel,
  type ReadyEmail,
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
  const { fromNameForApp } = await import("./mailer");
  expect(await fromNameForApp(null)).toBe("Medialane");
});

const message: EmailMessage = { to: "a@b.co", template: "verification-code", data: { code: "482913" } };
const delivers: EmailChannel = async () => true;
const notDelivered: EmailChannel = async () => false;
const fails: EmailChannel = async () => { throw new Error("down"); };

test("sendEmail renders the template and hands the finished email to the channel", async () => {
  let seen: ReadyEmail | null = null;
  const channel: EmailChannel = async (email) => (seen = email, true);
  expect(await sendEmail({ ...message, fromName: "Acme" }, channel)).toBe(true);
  expect(seen).toMatchObject({ to: "a@b.co", fromName: "Acme", subject: "Your verification code" });
  expect(seen!.html).toContain("482913");
});

test("sendEmail sends as Medialane when no sender name is given", async () => {
  let seen: ReadyEmail | null = null;
  await sendEmail(message, async (email) => (seen = email, true));
  expect(seen!.fromName).toBe("Medialane");
});

test("sendEmail reports false, and does not throw, when the email is not delivered or the channel fails", async () => {
  expect(await sendEmail(message, delivers)).toBe(true);
  expect(await sendEmail(message, notDelivered)).toBe(false);
  expect(await sendEmail(message, fails)).toBe(false);
});

describe("the mail provider channel", () => {
  const realFetch = globalThis.fetch;
  const saved = { token: env.ZEPTOMAIL_TOKEN, from: env.CONTACT_FROM_EMAIL };
  const email: ReadyEmail = { to: "a@b.co", fromName: "Acme", subject: "Hi", html: "<p>Hi</p>", text: "Hi" };
  afterEach(() => {
    globalThis.fetch = realFetch;
    env.ZEPTOMAIL_TOKEN = saved.token;
    env.CONTACT_FROM_EMAIL = saved.from;
  });

  test("posts the sender, one recipient and both bodies with the token", async () => {
    env.ZEPTOMAIL_TOKEN = "tok";
    env.CONTACT_FROM_EMAIL = "noreply@medialane.io";
    let seen: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    expect(await zeptoMailChannel(email)).toBe(true);
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Zoho-enczapikey tok");
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      from: { address: "noreply@medialane.io", name: "Acme" },
      to: [{ email_address: { address: "a@b.co" } }],
      subject: "Hi",
      htmlbody: "<p>Hi</p>",
      textbody: "Hi",
    });
  });

  test("sets the reply address only when there is one", async () => {
    env.ZEPTOMAIL_TOKEN = "tok";
    env.CONTACT_FROM_EMAIL = "noreply@medialane.io";
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await zeptoMailChannel({ ...email, replyTo: "p@q.co" });
    await zeptoMailChannel(email);
    expect(bodies[0]!.reply_to).toEqual([{ address: "p@q.co" }]);
    expect(bodies[1]).not.toHaveProperty("reply_to");
  });

  test("is not delivered without a token and a from address", async () => {
    env.ZEPTOMAIL_TOKEN = "";
    env.CONTACT_FROM_EMAIL = "";
    expect(await zeptoMailChannel(email)).toBe(false);
  });

  test("a refusal from the provider is not delivered", async () => {
    env.ZEPTOMAIL_TOKEN = "tok";
    env.CONTACT_FROM_EMAIL = "noreply@medialane.io";
    globalThis.fetch = (async () => new Response('{"error":{"code":"TM_4001"}}', { status: 401 })) as unknown as typeof fetch;
    expect(await zeptoMailChannel(email)).toBe(false);
  });
});

describe("a send failure", () => {
  test("keeps the status and the provider error code", () => {
    expect(sendFailure(401, { error: { code: "TM_4001", message: "Access Denied" } })).toEqual({ status: 401, code: "TM_4001" });
    expect(sendFailure(400, { data: { error_code: "TM_3004", message: "Invalid request" } })).toEqual({ status: 400, code: "TM_3004" });
  });

  test("never keeps messages or details, which can carry addresses", () => {
    const body = { error: { code: "TM_3201", message: "Invalid address a@b.co", details: [{ target: "a@b.co" }] } };
    expect(JSON.stringify(sendFailure(400, body))).not.toContain("a@b.co");
  });

  test("drops a code that is not in the expected shape", () => {
    expect(sendFailure(500, { error: { code: "a@b.co" } })).toEqual({ status: 500 });
    expect(sendFailure(500, null)).toEqual({ status: 500 });
    expect(sendFailure(500, "boom")).toEqual({ status: 500 });
  });
});

describe("the verification code email", () => {
  test("is sent to the person, under the sender name of the app that asked for it", async () => {
    const sent: EmailMessage[] = [];
    const deps = {
      send: async (m: EmailMessage) => (sent.push(m), true),
      fromNameFor: async (appId: string | null) => (appId === "client_ACME" ? "Acme Studios" : "Medialane"),
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
