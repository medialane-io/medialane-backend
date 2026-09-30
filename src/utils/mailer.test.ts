import { test, expect } from "bun:test";
import {
  buildVerificationCodeEmailHtml,
  buildGuardianEscapeTriggeredEmailHtml,
  buildGuardianSetEmailHtml,
  buildGuardianEscapeCompletedEmailHtml,
} from "./mailer";

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
