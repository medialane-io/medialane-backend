import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { sendEmail, type EmailMessage } from "./mailer.js";
import { buildWelcomeEmail } from "./welcomeEmail.js";
import { issueConfirmToken } from "./emailConfirmToken.js";
import { getCurrentEmailIdentity } from "./emailVerification.js";
import { verificationDeadline } from "../orchestrator/unverifiedAccounts.js";

export interface WelcomeAccount {
  status: "PENDING" | "ACTIVE" | "INACTIVE";
  createdAt: Date;
  email: string | null;
  emailVerified: boolean;
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
  if (!account || account.status !== "PENDING" || !account.email || account.emailVerified) return false;

  const deadline = verificationDeadline(account.createdAt);
  if (deadline.getTime() <= deps.now().getTime()) return false;

  const token = issueConfirmToken(deps.secret, { accountId: input.accountId, email: account.email, expiresAt: deadline });
  const email = buildWelcomeEmail({
    confirmUrl: `${deps.appUrl}/confirm-email?token=${encodeURIComponent(token)}`,
    walletAddress: input.walletAddress,
    deadline,
    settingsUrl: `${deps.appUrl}/settings`,
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
      return {
        status: account.status,
        createdAt: account.createdAt,
        email: identity?.email ?? null,
        emailVerified: identity?.verifiedAt != null,
      };
    },
    send: sendEmail,
    secret: env.SIWS_SECRET,
    ioClientId: env.IO_CLIENT_ID,
    appUrl: env.IO_APP_URL,
    now: () => new Date(),
  };
}
