import { describe, expect, test, mock } from "bun:test";

process.env.SMTP_HOST = "smtp.test.invalid";
process.env.SMTP_USER = "test@test.invalid";
process.env.SMTP_PASS = "test-pass";

const sendMail = mock(async (_opts: { to: string; html: string; subject: string }) => ({}));
mock.module("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

describe("sendProvisioningClaimEmail", () => {
  test("sends generic claim copy with no client-specific wording", async () => {
    const { sendProvisioningClaimEmail } = await import("./mailer.js");
    await sendProvisioningClaimEmail("worker@example.com", "https://medialane.io/claim/abc123");
    expect(sendMail).toHaveBeenCalledTimes(1);
    const call = sendMail.mock.calls[0][0];
    expect(call.to).toBe("worker@example.com");
    expect(call.html).toContain("https://medialane.io/claim/abc123");
    expect(call.html.toLowerCase()).not.toContain("magazine");
  });
});
