import { Resend } from "resend";
import { env } from "../config/env.js";
import { createLogger } from "./logger.js";

const log = createLogger("mailer");

let _resend: Resend | null = null;
function getResend(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(env.RESEND_API_KEY);
  return _resend;
}

export async function sendUsernameClaimApproved(to: string, username: string): Promise<void> {
  const resend = getResend();
  if (!resend) { log.warn("RESEND_API_KEY not set — skipping approval email"); return; }
  try {
    await resend.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to,
      subject: `@${username} is yours on Medialane!`,
      html: `
        <p>Hi there,</p>
        <p>Your username claim for <strong>@${username}</strong> has been <strong>approved</strong> by the Medialane DAO team.</p>
        <p>Your public creator profile is now live at:<br>
        <a href="https://medialane.io/creator/${username}">medialane.io/creator/${username}</a></p>
        <p>— The Medialane Team</p>
      `,
    });
  } catch (err) {
    log.error({ err }, "Failed to send approval email");
  }
}

export async function sendUsernameClaimRejected(to: string, username: string, adminNotes: string | null): Promise<void> {
  const resend = getResend();
  if (!resend) { log.warn("RESEND_API_KEY not set — skipping rejection email"); return; }
  try {
    await resend.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to,
      subject: `Username claim for @${username} — update`,
      html: `
        <p>Hi there,</p>
        <p>Your username claim for <strong>@${username}</strong> was not approved at this time.</p>
        ${adminNotes ? `<p>Reason: <em>${adminNotes}</em></p>` : ""}
        <p>You can submit a new claim from your <a href="https://medialane.io/portfolio/settings">profile settings</a>.</p>
        <p>— The Medialane Team</p>
      `,
    });
  } catch (err) {
    log.error({ err }, "Failed to send rejection email");
  }
}
