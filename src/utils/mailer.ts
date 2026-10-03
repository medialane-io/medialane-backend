import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { createLogger } from "./logger.js";
import { htmlToText } from "./emailText.js";
import prisma from "../db/client.js";

const log = createLogger("mailer");

const DEFAULT_FROM_NAME = "Medialane";

function createTransporter() {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
}

const from = (name: string = DEFAULT_FROM_NAME) => ({ name, address: env.CONTACT_FROM_EMAIL || env.SMTP_USER });

const MAX_FROM_NAME_LENGTH = 40;

export function sanitizeFromName(name: string | null | undefined): string {
  const cleaned = (name ?? "")
    .replace(/[^\p{L}\p{N} .&'’-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FROM_NAME_LENGTH)
    .trim();
  return cleaned || DEFAULT_FROM_NAME;
}

export async function fromNameForClient(clientId: string | null): Promise<string> {
  if (!clientId) return DEFAULT_FROM_NAME;
  const client = await prisma.apiClient.findUnique({
    where: { id: clientId },
    select: { account: { select: { profile: { select: { name: true } } } } },
  });
  return sanitizeFromName(client?.account.profile?.name);
}

const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

function buildGuardianAlertEmailHtml(headline: string, bodyHtml: string): string {
  return `
    <div style="max-width:480px;margin:0 auto;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
      <div style="text-align:center;padding-bottom:28px;">
        <img src="https://medialane.io/medialane-light-logo.png" alt="Medialane" height="28" style="height:28px;" />
      </div>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:16px;padding:32px 24px;">
        <p style="margin:0 0 8px;color:#991b1b;font-size:15px;font-weight:700;">${headline}</p>
        ${bodyHtml}
      </div>
      <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:24px;">
        Medialane will never ask you for your recovery key. Treat any message requesting it as an attempt to take your assets.
      </p>
    </div>
  `;
}

async function sendGuardianAlertEmail(
  to: string,
  subject: string,
  html: string,
  logLabel: string,
  send: (message: EmailMessage) => Promise<boolean>,
): Promise<void> {
  const delivered = await send({ to, subject, html, text: htmlToText(html) });
  if (!delivered) log.warn(`Could not send the ${logLabel} email`);
}

export function buildGuardianEscapeTriggeredEmailHtml(walletAddress: string, readyAt: Date): string {
  const short = shortAddress(walletAddress);
  return buildGuardianAlertEmailHtml(
    "A guardian started replacing your wallet's owner key",
    `
    <p style="margin:0 0 12px;color:#111827;font-size:14px;">Wallet ${short} can get a new owner key on or after
      <strong>${readyAt.toUTCString()}</strong> unless you cancel it first.</p>
    <p style="margin:0;color:#111827;font-size:14px;">If this was you (recovering with a guardian), no action is needed.
      If it wasn't, open Medialane, go to Settings → Security &amp; Recovery, and cancel it now.</p>
    `,
  );
}

export async function sendGuardianEscapeTriggeredEmail(
  to: string,
  walletAddress: string,
  readyAt: Date,
  send: (message: EmailMessage) => Promise<boolean> = sendEmail,
): Promise<void> {
  await sendGuardianAlertEmail(
    to,
    "Security alert: a guardian started recovering your Medialane wallet",
    buildGuardianEscapeTriggeredEmailHtml(walletAddress, readyAt),
    "guardian escape alert",
    send,
  );
}

export function buildGuardianSetEmailHtml(walletAddress: string): string {
  const short = shortAddress(walletAddress);
  return buildGuardianAlertEmailHtml(
    "A guardian was added to your wallet",
    `
    <p style="margin:0;color:#111827;font-size:14px;">A guardian can now help recover wallet ${short} if you lose every
      device, but can never move your funds directly. If you set this up yourself, no action is needed.
      If you didn't, open Medialane and check Settings → Security &amp; Recovery.</p>
    `,
  );
}

export async function sendGuardianSetEmail(
  to: string,
  walletAddress: string,
  send: (message: EmailMessage) => Promise<boolean> = sendEmail,
): Promise<void> {
  await sendGuardianAlertEmail(
    to,
    "A guardian was added to your Medialane wallet",
    buildGuardianSetEmailHtml(walletAddress),
    "guardian added alert",
    send,
  );
}

export function buildGuardianEscapeCompletedEmailHtml(walletAddress: string): string {
  const short = shortAddress(walletAddress);
  return buildGuardianAlertEmailHtml(
    "Your wallet's owner key was just replaced by a guardian",
    `
    <p style="margin:0;color:#111827;font-size:14px;">Wallet ${short} now has a new owner key, set by its guardian.
      If this was you completing a recovery, no action is needed. If it wasn't, your old device's key no longer
      controls this wallet — contact support right away.</p>
    `,
  );
}

export async function sendGuardianEscapeCompletedEmail(
  to: string,
  walletAddress: string,
  send: (message: EmailMessage) => Promise<boolean> = sendEmail,
): Promise<void> {
  await sendGuardianAlertEmail(
    to,
    "Security alert: your Medialane wallet's owner key was replaced",
    buildGuardianEscapeCompletedEmailHtml(walletAddress),
    "guardian escape completed alert",
    send,
  );
}

export function buildVerificationCodeEmailHtml(code: string): string {
  return `
    <div style="max-width:480px;margin:0 auto;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
      <div style="text-align:center;padding-bottom:28px;">
        <img src="https://medialane.io/medialane-light-logo.png" alt="Medialane" height="28" style="height:28px;" />
      </div>
      <div style="background:#f6f7f9;border-radius:16px;padding:32px 24px;text-align:center;">
        <p style="margin:0 0 4px;color:#111827;font-size:15px;">Your verification code</p>
        <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#111827;margin:16px 0;">${code}</div>
        <p style="margin:0;color:#6b7280;font-size:13px;">This code expires in 10 minutes.</p>
      </div>
      <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:24px;">
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  `;
}

export function buildVerificationCodeEmail(code: string): { subject: string; html: string; text: string } {
  const text = [
    `Your verification code is ${code}.`,
    "",
    "This code expires in 10 minutes.",
    "",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");
  return { subject: "Your verification code", html: buildVerificationCodeEmailHtml(code), text };
}

export interface VerificationMailDeps {
  send: (message: EmailMessage) => Promise<boolean>;
  fromNameFor: (clientId: string | null) => Promise<string>;
}

export async function sendVerificationCode(
  to: string,
  code: string,
  clientId: string | null = null,
  deps: VerificationMailDeps = { send: sendEmail, fromNameFor: fromNameForClient },
): Promise<void> {
  const fromName = await deps.fromNameFor(clientId);
  const delivered = await deps.send({ to, fromName, ...buildVerificationCodeEmail(code) });
  if (!delivered) log.warn("Could not send the verification code email");
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName?: string;
}

export type EmailChannel = (message: EmailMessage) => Promise<boolean>;

const relayChannel: EmailChannel = async (message) => {
  if (!env.MAIL_RELAY_URL || !env.MAIL_RELAY_SECRET) return false;
  const res = await fetch(`${env.MAIL_RELAY_URL}/api/internal/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-relay-secret": env.MAIL_RELAY_SECRET },
    body: JSON.stringify({ ...message, fromName: message.fromName ?? DEFAULT_FROM_NAME }),
  });
  if (!res.ok) throw new Error(`relay responded ${res.status}: ${await res.text().catch(() => "")}`);
  return true;
};

const smtpChannel: EmailChannel = async (message) => {
  const transporter = createTransporter();
  if (!transporter) return false;
  await transporter.sendMail({
    from: from(message.fromName),
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
  return true;
};

export async function sendEmail(
  message: EmailMessage,
  channels: EmailChannel[] = [relayChannel, smtpChannel],
): Promise<boolean> {
  for (const channel of channels) {
    try {
      if (await channel(message)) return true;
    } catch (err) {
      log.error({ err }, "Email channel failed, trying the next one");
    }
  }
  log.warn({ subject: message.subject }, "No email channel delivered the message");
  return false;
}
