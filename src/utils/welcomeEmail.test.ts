import { test, expect } from "bun:test";
import { buildWelcomeEmail, formatDeadline } from "./welcomeEmail";

const input = {
  confirmUrl: "https://www.medialane.io/confirm-email?token=abc.def&x=1",
  walletAddress: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  deadline: new Date("2026-10-10T12:00:00Z"),
  settingsUrl: "https://www.medialane.io/settings",
};

test("the deadline reads as a plain date in UTC", () => {
  expect(formatDeadline(new Date("2026-10-10T23:59:00Z"))).toBe("10 October 2026");
});

test("the email carries the confirm link, the full wallet address and the date, in both html and text", () => {
  const { html, text, subject } = buildWelcomeEmail(input);
  expect(subject).toBe("Welcome to Medialane — confirm your email");
  for (const body of [html, text]) {
    expect(body).toContain(input.walletAddress);
    expect(body).toContain("10 October 2026");
  }
  expect(html).toContain("token=abc.def&amp;x=1");
  expect(text).toContain(input.confirmUrl);
});

test("it tells the person what happens if they do not confirm", () => {
  const { text } = buildWelcomeEmail(input);
  expect(text.toLowerCase()).toContain("closed");
});

test("it ends with where to secure the account", () => {
  const { html, text } = buildWelcomeEmail(input);
  expect(html).toContain(input.settingsUrl);
  expect(text).toContain(input.settingsUrl);
});

test("it never mentions the chain and links only to confirm and settings", () => {
  const { html, text } = buildWelcomeEmail(input);
  expect(`${html}${text}`.toLowerCase()).not.toContain("starknet");
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  expect(links).toEqual([input.confirmUrl.replace(/&/g, "&amp;"), input.settingsUrl]);
});

test("anything that goes into the page is escaped", () => {
  const { html } = buildWelcomeEmail({ ...input, walletAddress: `0x1"><script>x</script>` });
  expect(html).not.toContain("<script>");
});
