import { Prisma } from "@prisma/client";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { IDENTITY_SCHEME } from "../utils/identity.js";
import { IO_APP } from "../utils/caller.js";
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
  const accounts = await prisma.account.findMany({
    where: {
      status: "PENDING",
      createdAt: {
        gt: new Date(now.getTime() - IO_VERIFICATION_DAYS * DAY_MS),
        lte: new Date(now.getTime() - VERIFICATION_REMINDER_AFTER_DAYS * DAY_MS),
      },
      notices: { none: { kind: "verification-reminder" } },
      AND: [
        { identities: { some: { scheme: IDENTITY_SCHEME.EMAIL, appId: IO_APP } } },
        { identities: { some: { scheme: IDENTITY_SCHEME.WALLET } } },
      ],
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      identities: { select: { scheme: true, value: true, appId: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  return accounts.flatMap((account) => {
    const emailIdentity = account.identities.find((i) => i.scheme === IDENTITY_SCHEME.EMAIL && i.appId === IO_APP);
    const email = emailIdentity?.value ?? null;
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
          hasWallet: account.identities.some((i) => i.scheme === IDENTITY_SCHEME.WALLET),
        },
      },
    ];
  });
}

export function productionSweepDeps(): SweepDeps {
  return {
    findReminderCandidates,
    stillPending: async (accountId) =>
      (await prisma.account.count({ where: { id: accountId, status: "PENDING" } })) > 0,
    store: prismaNoticeStore,
    send: sendEmail,
    confirmToken: (accountId, email, deadline) =>
      issueConfirmToken(env.SIWS_SECRET, { accountId, email, expiresAt: deadline }),
    now: () => new Date(),
    batchLimit: 200,
  };
}
