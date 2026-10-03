import { test, expect } from "bun:test";
import { buildWelcomeEmail, formatDeadline } from "./welcomeEmail";

const ADDRESS = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const confirm = {
  url: "https://www.medialane.io/confirm-email#token=abc.def&x=1",
  deadline: new Date("2026-10-10T12:00:00Z"),
};
const base = { walletAddress: ADDRESS, settingsUrl: "https://www.medialane.io/settings" };
const unverified = { ...base, confirm };
const verified = { ...base, confirm: null };

test("the deadline reads as a plain date in UTC", () => {
  expect(formatDeadline(new Date("2026-10-10T23:59:00Z"))).toBe("10 October 2026");
});

test("an unverified account's email carries the confirm link, the address and the date, in html and text", () => {
  const { html, text, subject } = buildWelcomeEmail(unverified);
  expect(subject).toBe("Welcome to Medialane — confirm your email");
  for (const body of [html, text]) {
    expect(body).toContain(ADDRESS);
    expect(body).toContain("10 October 2026");
  }
  expect(html).toContain("token=abc.def&amp;x=1");
  expect(text).toContain(confirm.url);
  expect(text.toLowerCase()).toContain("closed");
});

test("a verified account's email is a plain welcome: no confirm button, no deadline", () => {
  const { html, text, subject } = buildWelcomeEmail(verified);
  expect(subject).toBe("Welcome to Medialane");
  for (const body of [html, text]) {
    expect(body).toContain(ADDRESS);
    expect(body.toLowerCase()).not.toContain("confirm");
    expect(body).not.toContain("closed");
  }
});

test("both end with where to secure the account", () => {
  for (const input of [unverified, verified]) {
    const { html, text } = buildWelcomeEmail(input);
    expect(html).toContain(base.settingsUrl);
    expect(text).toContain(base.settingsUrl);
  }
});

test("it never mentions the chain, and links only to confirm (when needed) and settings", () => {
  const withConfirm = buildWelcomeEmail(unverified);
  const without = buildWelcomeEmail(verified);
  for (const { html, text } of [withConfirm, without]) {
    expect(`${html}${text}`.toLowerCase()).not.toContain("starknet");
  }
  const links = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  expect(links(withConfirm.html)).toEqual([confirm.url.replace(/&/g, "&amp;"), base.settingsUrl]);
  expect(links(without.html)).toEqual([base.settingsUrl]);
});

test("the footer says to ignore the email if the person did not sign up, and that the recovery key is never asked for", () => {
  for (const input of [unverified, verified]) {
    const { html } = buildWelcomeEmail(input);
    expect(html).toContain("If you didn&#39;t sign up".replace("&#39;", "'"));
    expect(html).toContain("Medialane will never ask you for your recovery key");
  }
});

test("anything that goes into the page is escaped", () => {
  const { html } = buildWelcomeEmail({ ...verified, walletAddress: `0x1"><script>x</script>` });
  expect(html).not.toContain("<script>");
});
