import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { createLogger } from "./logger.js";

const log = createLogger("mailer");

function createTransporter() {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
}

const from = () => env.CONTACT_FROM_EMAIL || env.SMTP_USER;

export async function sendUsernameClaimApproved(to: string, username: string): Promise<void> {
  const transporter = createTransporter();
  if (!transporter) { log.warn("SMTP not configured — skipping approval email"); return; }
  try {
    await transporter.sendMail({
      from: from(),
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
  const transporter = createTransporter();
  if (!transporter) { log.warn("SMTP not configured — skipping rejection email"); return; }
  try {
    await transporter.sendMail({
      from: from(),
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
