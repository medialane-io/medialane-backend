export interface WelcomeEmailInput {
  confirmUrl: string;
  walletAddress: string;
  deadline: Date;
  settingsUrl: string;
}

const HIGHLIGHTS = [
  "Your creations are protected in 181 countries under the Berne Convention.",
  "Minting collections, NFTs and other digital assets is free.",
  "You hold your own keys. Medialane is only the interface, so your assets stay yours.",
  "Our contracts are immutable and battle-tested.",
  "We build around the CROPS philosophy, anchored in the Integrity Web axioms.",
  "Take part in our airdrop campaign.",
];

const esc = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function formatDeadline(date: Date): string {
  return date.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
}

export function buildWelcomeEmail(input: WelcomeEmailInput): { subject: string; html: string; text: string } {
  const deadline = formatDeadline(input.deadline);
  const closing = `If you don't confirm by ${deadline}, your account will be closed and this email address will be released.`;

  const text = [
    "Welcome to Medialane.",
    "",
    "Medialane is where creators protect, mint and share their work.",
    "",
    `Confirm your email: ${input.confirmUrl}`,
    closing,
    "",
    "Your Medialane wallet address (yours to save and share):",
    input.walletAddress,
    "",
    ...HIGHLIGHTS.map((line) => `- ${line}`),
    "",
    `Secure your account: add a second device or a guardian in Settings > Security & Recovery: ${input.settingsUrl}`,
    "",
    "If you didn't sign up, you can ignore this email. Medialane will never ask you for your recovery key.",
  ].join("\n");

  const html = `
    <div style="max-width:480px;margin:0 auto;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;">
      <div style="text-align:center;padding-bottom:28px;">
        <img src="https://medialane.io/medialane-light-logo.png" alt="Medialane" height="28" style="height:28px;" />
      </div>
      <h1 style="margin:0 0 8px;font-size:22px;">Welcome to Medialane</h1>
      <p style="margin:0 0 24px;font-size:15px;color:#4b5563;">Where creators protect, mint and share their work.</p>
      <div style="background:#f6f7f9;border-radius:16px;padding:24px;text-align:center;">
        <a href="${esc(input.confirmUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:10px;">Confirm my email</a>
        <p style="margin:16px 0 0;font-size:13px;color:#6b7280;">${esc(closing)}</p>
      </div>
      <p style="margin:28px 0 6px;font-size:14px;font-weight:600;">Your Medialane wallet address</p>
      <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Yours to save and share.</p>
      <p style="margin:0;padding:12px;background:#f6f7f9;border-radius:10px;font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all;">${esc(input.walletAddress)}</p>
      <ul style="margin:28px 0 0;padding-left:20px;font-size:14px;line-height:1.6;">
        ${HIGHLIGHTS.map((line) => `<li>${esc(line)}</li>`).join("\n        ")}
      </ul>
      <p style="margin:28px 0 0;font-size:14px;line-height:1.6;">
        <strong>Secure your account.</strong> Add a second device or a guardian in
        <a href="${esc(input.settingsUrl)}" style="color:#111827;">Settings &rsaquo; Security &amp; Recovery</a>.
      </p>
      <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:28px;">
        If you didn't sign up, you can ignore this email. Medialane will never ask you for your recovery key.
      </p>
    </div>
  `;

  return { subject: "Welcome to Medialane — confirm your email", html, text };
}
