import { describe, expect, test } from "bun:test";
import { buildProvisioningClaimEmailHtml } from "./mailer.js";

describe("buildProvisioningClaimEmailHtml", () => {
  test("includes the claim URL and stays generic — no client-specific wording", () => {
    const html = buildProvisioningClaimEmailHtml("https://medialane.io/claim/abc123");
    expect(html).toContain("https://medialane.io/claim/abc123");
    expect(html.toLowerCase()).not.toContain("magazine");
  });
});
