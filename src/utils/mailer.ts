import { env } from "../config/env.js";
import { createLogger } from "./logger.js";
import prisma from "../db/client.js";

const log = createLogger("mailer");

const DEFAULT_FROM_NAME = "Medialane";
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

export async function fromNameForApp(appId: string | null): Promise<string> {
  if (!appId) return DEFAULT_FROM_NAME;
  const app = await prisma.app.findUnique({ where: { id: appId }, select: { name: true } });
  return sanitizeFromName(app?.name);
}

export type EmailTemplate =
  | { template: "verification-code"; data: { code: string } }
  | { template: "welcome"; data: { walletAddress: string; confirm: { token: string; deadline: Date } | null } }
  | { template: "verification-reminder"; data: { confirmToken: string; deadline: Date } }
  | { template: "guardian-set"; data: { walletAddress: string } }
  | { template: "guardian-escape-triggered"; data: { walletAddress: string; readyAt: Date } }
  | { template: "guardian-escape-completed"; data: { walletAddress: string } };

export type EmailMessage = EmailTemplate & { to: string; fromName?: string };

export type EmailChannel = (message: EmailMessage) => Promise<boolean>;

export const relayChannel: EmailChannel = async (message) => {
  if (!env.MAIL_RELAY_URL || !env.MAIL_RELAY_SECRET) return false;
  const res = await fetch(`${env.MAIL_RELAY_URL}/api/internal/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-relay-secret": env.MAIL_RELAY_SECRET },
    body: JSON.stringify({ ...message, fromName: message.fromName ?? DEFAULT_FROM_NAME }),
  });
  if (!res.ok) throw new Error(`relay responded ${res.status}: ${await res.text().catch(() => "")}`);
  return true;
};

export async function sendEmail(message: EmailMessage, channels: EmailChannel[] = [relayChannel]): Promise<boolean> {
  for (const channel of channels) {
    try {
      if (await channel(message)) return true;
    } catch (err) {
      log.error({ err }, "Email channel failed, trying the next one");
    }
  }
  log.warn({ template: message.template }, "No email channel delivered the message");
  return false;
}

type Send = (message: EmailMessage) => Promise<boolean>;

export interface VerificationMailDeps {
  send: Send;
  fromNameFor: (appId: string | null) => Promise<string>;
}

export async function sendVerificationCode(
  to: string,
  code: string,
  appId: string | null = null,
  deps: VerificationMailDeps = { send: sendEmail, fromNameFor: fromNameForApp },
): Promise<void> {
  const fromName = await deps.fromNameFor(appId);
  const delivered = await deps.send({ to, fromName, template: "verification-code", data: { code } });
  if (!delivered) log.warn("Could not send the verification code email");
}

async function sendGuardianAlert(message: EmailMessage, logLabel: string, send: Send): Promise<void> {
  if (!(await send(message))) log.warn(`Could not send the ${logLabel} email`);
}

export const sendGuardianSetEmail = (to: string, walletAddress: string, send: Send = sendEmail): Promise<void> =>
  sendGuardianAlert({ to, template: "guardian-set", data: { walletAddress } }, "guardian added alert", send);

export const sendGuardianEscapeTriggeredEmail = (
  to: string,
  walletAddress: string,
  readyAt: Date,
  send: Send = sendEmail,
): Promise<void> =>
  sendGuardianAlert(
    { to, template: "guardian-escape-triggered", data: { walletAddress, readyAt } },
    "guardian escape alert",
    send,
  );

export const sendGuardianEscapeCompletedEmail = (to: string, walletAddress: string, send: Send = sendEmail): Promise<void> =>
  sendGuardianAlert(
    { to, template: "guardian-escape-completed", data: { walletAddress } },
    "guardian escape completed alert",
    send,
  );
