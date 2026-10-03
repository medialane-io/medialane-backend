import { Prisma } from "@prisma/client";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { IDENTITY_SCHEME } from "../utils/identity.js";
import { issueConfirmToken } from "../utils/emailConfirmToken.js";
import { sendEmail } from "../utils/mailer.js";
import { DAY_MS, IO_VERIFICATION_DAYS, VERIFICATION_REMINDER_AFTER_DAYS } from "../utils/accountLifecycle.js";
import type { NoticeStore, ReminderCandidate, SweepDeps } from "./sweep.js";

export const prismaNoticeStore: NoticeStore = {
  claim: async (accountId, kind) => {
    try {
      await prisma.accountNotice.create({ data: { accountId, kind } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
      throw err;
    }
  },
  release: async (accountId, kind) => {
    await prisma.accountNotice.deleteMany({ where: { accountId, kind } });
  },
};

async function findReminderCandidates(now: Date, limit: number): Promise<ReminderCandidate[]> {
  const ioClientId = env.IO_CLIENT_ID;
  if (!ioClientId) return [];

  const accounts = await prisma.account.findMany({
    where: {
      status: "PENDING",
      createdAt: {
        gt: new Date(now.getTime() - IO_VERIFICATION_DAYS * DAY_MS),
        lte: new Date(now.getTime() - VERIFICATION_REMINDER_AFTER_DAYS * DAY_MS),
      },
      notices: { none: { kind: "verification-reminder" } },
      AND: [
        { identities: { some: { scheme: IDENTITY_SCHEME.EMAIL, clientId: ioClientId, verifiedAt: null } } },
        { identities: { some: { scheme: IDENTITY_SCHEME.WALLET } } },
      ],
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      identities: { select: { scheme: true, email: true, value: true, clientId: true, verifiedAt: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  return accounts.flatMap((account) => {
    const emailIdentity = account.identities.find((i) => i.scheme === IDENTITY_SCHEME.EMAIL && i.clientId === ioClientId);
    const email = emailIdentity?.email ?? emailIdentity?.value ?? null;
    if (!emailIdentity || !email) return [];
    return [
      {
        accountId: account.id,
        email,
        createdAt: account.createdAt,
        facts: {
          status: account.status,
          createdAt: account.createdAt,
          isIo: true,
          hasEmail: true,
          emailVerified: emailIdentity.verifiedAt !== null,
          hasWallet: account.identities.some((i) => i.scheme === IDENTITY_SCHEME.WALLET),
        },
      },
    ];
  });
}

export function productionSweepDeps(): SweepDeps {
  return {
    findReminderCandidates,
    stillUnverified: async (accountId) => {
      const count = await prisma.identity.count({
        where: { accountId, scheme: IDENTITY_SCHEME.EMAIL, verifiedAt: null },
      });
      return count > 0;
    },
    store: prismaNoticeStore,
    send: sendEmail,
    confirmUrl: (accountId, email, deadline) => {
      const token = issueConfirmToken(env.SIWS_SECRET, { accountId, email, expiresAt: deadline });
      return `${env.IO_APP_URL}/confirm-email?token=${encodeURIComponent(token)}`;
    },
    now: () => new Date(),
    batchLimit: 200,
  };
}
