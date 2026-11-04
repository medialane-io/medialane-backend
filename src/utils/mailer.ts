import { env } from "../config/env.js";
import { createLogger } from "./logger.js";
import prisma from "../db/client.js";
import { renderTemplate, type RenderedEmail, type TemplateRequest } from "./mailTemplates.js";

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

export type EmailMessage = TemplateRequest & { to: string; fromName?: string; replyTo?: string };

export interface ReadyEmail extends RenderedEmail {
  to: string;
  fromName: string;
  replyTo?: string;
}

export type EmailChannel = (email: ReadyEmail) => Promise<boolean>;

const ZEPTOMAIL_URL = "https://cpaas.zoho.com/v1.1/email";
const PROVIDER_ERROR_CODE = /^[A-Z]{2,5}_\d{3,5}$/;

export function sendFailure(status: number, body: unknown): { status: number; code?: string } {
  const failure: { status: number; code?: string } = { status };
  if (typeof body !== "object" || body === null) return failure;
  const b = body as { error?: { code?: unknown }; data?: { error_code?: unknown } };
  const code = b.error?.code ?? b.data?.error_code;
  if (typeof code === "string" && PROVIDER_ERROR_CODE.test(code)) failure.code = code;
  return failure;
}

export function zeptoMailBody(email: ReadyEmail, fromAddress: string) {
  return {
    from: { address: fromAddress, name: email.fromName },
    to: [{ email_address: { address: email.to } }],
    subject: email.subject,
    htmlbody: email.html,
    textbody: email.text,
    ...(email.replyTo ? { reply_to: [{ address: email.replyTo }] } : {}),
  };
}

export const zeptoMailChannel: EmailChannel = async (email) => {
  if (!env.ZEPTOMAIL_TOKEN || !env.CONTACT_FROM_EMAIL) return false;
  const res = await fetch(ZEPTOMAIL_URL, {
    method: "POST",
    headers: { Authorization: `Zoho-enczapikey ${env.ZEPTOMAIL_TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(zeptoMailBody(email, env.CONTACT_FROM_EMAIL)),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return true;
  log.error(sendFailure(res.status, await res.json().catch(() => null)), "Email send failed");
  return false;
};

export async function sendEmail(message: EmailMessage, channel: EmailChannel = zeptoMailChannel): Promise<boolean> {
  const { to, fromName, replyTo, ...template } = message;
  try {
    const delivered = await channel({ to, fromName: fromName ?? DEFAULT_FROM_NAME, replyTo, ...renderTemplate(template, env.IO_APP_URL) });
    if (!delivered) log.warn({ template: message.template }, "Email was not delivered");
    return delivered;
  } catch (err) {
    log.error({ code: err instanceof Error ? err.name : undefined }, "Email send failed");
    return false;
  }
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
