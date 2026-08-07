import { test, expect } from "bun:test";
import { buildVerificationCodeEmailHtml } from "./mailer";

test("buildVerificationCodeEmailHtml includes the code", () => {
  const html = buildVerificationCodeEmailHtml("482913");
  expect(html).toContain("482913");
});

test("buildVerificationCodeEmailHtml does not leak other codes", () => {
  const html = buildVerificationCodeEmailHtml("111111");
  expect(html).not.toContain("482913");
});
