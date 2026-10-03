import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { sendEmail, type EmailMessage } from "./mailer.js";
import { buildWelcomeEmail } from "./welcomeEmail.js";
import { issueConfirmToken } from "./emailConfirmToken.js";
import { getCurrentEmailIdentity } from "./emailVerification.js";
import { IDENTITY_SCHEME } from "./identity.js";
import { verificationDeadline } from "../orchestrator/unverifiedAccounts.js";

export interface WelcomeAccount {
  status: "PENDING" | "ACTIVE" | "INACTIVE";
  createdAt: Date;
  email: string | null;
  emailVerified: boolean;
  walletCount: number;
}

export interface WelcomeDeps {
  loadAccount: (accountId: string) => Promise<WelcomeAccount | null>;
  send: (message: EmailMessage) => Promise<boolean>;
  secret: string;
  ioClientId: string;
  appUrl: string;
  now: () => Date;
}

export async function sendWelcomeIfDue(
  deps: WelcomeDeps,
  input: { accountId: string; clientId: string; walletAddress: string; walletLinked: boolean },
): Promise<boolean> {
  if (!input.walletLinked) return false;
  if (!deps.ioClientId || input.clientId !== deps.ioClientId) return false;

  const account = await deps.loadAccount(input.accountId);
  if (!account || account.status === "INACTIVE" || !account.email || account.walletCount !== 1) return false;

  let confirm: { url: string; deadline: Date } | null = null;
  if (!account.emailVerified) {
    const deadline = verificationDeadline(account.createdAt);
    if (deadline.getTime() <= deps.now().getTime()) return false;
    const token = issueConfirmToken(deps.secret, { accountId: input.accountId, email: account.email, expiresAt: deadline });
    confirm = { url: `${deps.appUrl}/confirm-email?token=${encodeURIComponent(token)}`, deadline };
  }

  const email = buildWelcomeEmail({
    walletAddress: input.walletAddress,
    settingsUrl: `${deps.appUrl}/settings`,
    confirm,
  });
  return deps.send({ to: account.email, ...email });
}

export function productionWelcomeDeps(): WelcomeDeps {
  return {
    loadAccount: async (accountId) => {
      const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: { status: true, createdAt: true },
      });
      if (!account) return null;
      const identity = await getCurrentEmailIdentity(accountId);
      const walletCount = await prisma.identity.count({ where: { accountId, scheme: IDENTITY_SCHEME.WALLET } });
      return {
        status: account.status,
        createdAt: account.createdAt,
        email: identity?.email ?? null,
        emailVerified: identity?.verifiedAt != null,
        walletCount,
      };
    },
    send: sendEmail,
    secret: env.SIWS_SECRET,
    ioClientId: env.IO_CLIENT_ID,
    appUrl: env.IO_APP_URL,
    now: () => new Date(),
  };
}
