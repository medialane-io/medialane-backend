import { emailLayout, escapeHtml } from "./emailLayout.js";
import { formatDeadline } from "./welcomeEmail.js";

export interface ReminderEmailInput {
  confirmUrl: string;
  deadline: Date;
}

export function buildReminderEmail(input: ReminderEmailInput): { subject: string; html: string; text: string } {
  const date = formatDeadline(input.deadline);
  const consequence = `If it isn't confirmed by ${date}, your account will be closed and this email address will be released. A closed account cannot be reopened.`;

  const text = [
    `Your Medialane account closes on ${date} unless you confirm your email.`,
    "",
    `Confirm your email: ${input.confirmUrl}`,
    "",
    consequence,
    "",
    "If you didn't sign up, you can ignore this email. Medialane will never ask you for your recovery key.",
  ].join("\n");

  const content = `
      <h1 style="margin:0 0 8px;font-size:22px;">Confirm your email to keep your account</h1>
      <p style="margin:0 0 24px;font-size:15px;color:#4b5563;">Your Medialane account closes on <strong>${escapeHtml(date)}</strong> unless you confirm your email.</p>
      <div style="background:#f6f7f9;border-radius:16px;padding:24px;text-align:center;">
        <a href="${escapeHtml(input.confirmUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:10px;">Confirm my email</a>
        <p style="margin:16px 0 0;font-size:13px;color:#6b7280;">${escapeHtml(consequence)}</p>
      </div>`;

  const html = emailLayout({
    content,
    footer: "If you didn't sign up, you can ignore this email. Medialane will never ask you for your recovery key.",
  });

  return { subject: `Confirm your email by ${date.replace(/ \d{4}$/, "")} to keep your Medialane account`, html, text };
}
