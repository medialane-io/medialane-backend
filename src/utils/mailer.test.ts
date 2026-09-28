import { test, expect } from "bun:test";
import { buildVerificationCodeEmailHtml, buildGuardianEscapeTriggeredEmailHtml } from "./mailer";

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
  const html = buildGuardianEscapeTriggeredEmailHtml(
    "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    readyAt,
  );
  expect(html).toContain("0x0123…cdef");
  expect(html).not.toContain("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  expect(html).toContain(readyAt.toUTCString());
});
