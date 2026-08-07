import { test, expect, afterEach } from "bun:test";
import { buildVerificationCodeEmailHtml, sendVerificationCode } from "./mailer";
import { env } from "../config/env.js";

test("buildVerificationCodeEmailHtml includes the code", () => {
  const html = buildVerificationCodeEmailHtml("482913");
  expect(html).toContain("482913");
});

test("buildVerificationCodeEmailHtml does not leak other codes", () => {
  const html = buildVerificationCodeEmailHtml("111111");
  expect(html).not.toContain("482913");
});

const realFetch = globalThis.fetch;
const realRelayUrl = env.MAIL_RELAY_URL;
const realRelaySecret = env.MAIL_RELAY_SECRET;
afterEach(() => {
  globalThis.fetch = realFetch;
  env.MAIL_RELAY_URL = realRelayUrl;
  env.MAIL_RELAY_SECRET = realRelaySecret;
});

test("sendVerificationCode relays over HTTPS when MAIL_RELAY_URL is configured, instead of connecting to SMTP directly", async () => {
  env.MAIL_RELAY_URL = "https://medialane.io/api/internal/send-verification-email";
  env.MAIL_RELAY_SECRET = "test-secret";

  const called: { url: string | null; init: RequestInit | null } = { url: null, init: null };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    called.url = url;
    called.init = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await sendVerificationCode("alice@example.com", "482913");

  expect(called.url).toBe("https://medialane.io/api/internal/send-verification-email");
  const init = called.init as unknown as RequestInit;
  expect((init.headers as Record<string, string>)["x-relay-secret"]).toBe("test-secret");
  const body = JSON.parse(String(init.body));
  expect(body).toEqual({ to: "alice@example.com", code: "482913" });
});
