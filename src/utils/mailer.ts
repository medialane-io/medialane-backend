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

/**
 * Pure HTML builder, split out from sendProvisioningClaimEmail so its content can be
 * unit-tested without mocking the mail transport (mock.module leaks process-globally
 * in this repo's bun test runs — DI or pure functions only).
 */
export function buildProvisioningClaimEmailHtml(claimUrl: string): string {
  return `
    <p>Hi there,</p>
    <p>An account has been set up for you, with your assets already in it.</p>
    <p>Claim it as your own — this takes a minute and confirms it belongs to you:<br>
    <a href="${claimUrl}">${claimUrl}</a></p>
    <p>— The Medialane Team</p>
  `;
}

export async function sendProvisioningClaimEmail(to: string, claimUrl: string): Promise<void> {
  const transporter = createTransporter();
  if (!transporter) { log.warn("SMTP not configured — skipping provisioning claim email"); return; }
  try {
    await transporter.sendMail({
      from: from(),
      to,
      subject: "An account is ready for you on Medialane",
      html: buildProvisioningClaimEmailHtml(claimUrl),
    });
  } catch (err) {
    log.error({ err }, "Failed to send provisioning claim email");
  }
}

/**
 * Pure HTML builder, same pattern as buildProvisioningClaimEmailHtml —
 * split out so it's unit-testable without mocking the mail transport.
 */
export function buildVerificationCodeEmailHtml(code: string): string {
  return `
    <p>Hi there,</p>
    <p>Your Medialane verification code is:</p>
    <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">${code}</p>
    <p>This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
    <p>— The Medialane Team</p>
  `;
}

export async function sendVerificationCode(to: string, code: string): Promise<void> {
  // Railway's outbound network cannot reach the configured SMTP host
  // (connection times out on connect). When a relay is configured, hand
  // the send off over HTTPS to medialane-io's Vercel deployment instead —
  // same SMTP credentials, different network path that can actually reach it.
  if (env.MAIL_RELAY_URL && env.MAIL_RELAY_SECRET) {
    try {
      const res = await fetch(env.MAIL_RELAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-relay-secret": env.MAIL_RELAY_SECRET },
        body: JSON.stringify({ to, code }),
      });
      if (!res.ok) {
        log.error({ status: res.status }, "Mail relay returned a non-OK status");
      }
    } catch (err) {
      log.error({ err }, "Failed to reach mail relay");
    }
    return;
  }

  const transporter = createTransporter();
  if (!transporter) { log.warn("SMTP not configured — skipping verification code email"); return; }
  try {
    await transporter.sendMail({
      from: from(),
      to,
      subject: "Your Medialane verification code",
      html: buildVerificationCodeEmailHtml(code),
    });
  } catch (err) {
    log.error({ err }, "Failed to send verification code email");
  }
}
