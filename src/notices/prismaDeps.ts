import { Prisma } from "@prisma/client";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { IDENTITY_SCHEME } from "../utils/identity.js";
import { IO_APP } from "../apps/registry.js";
import { issueConfirmToken } from "../utils/emailConfirmToken.js";
import { sendEmail } from "../utils/mailer.js";
import { DAY_MS, IO_VERIFICATION_DAYS, VERIFICATION_REMINDER_AFTER_DAYS } from "../utils/accountLifecycle.js";
import type { NoticeStore, ReminderCandidate, SweepDeps, WelcomeCandidate } from "./sweep.js";

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
        { identities: { some: { scheme: IDENTITY_SCHEME.EMAIL, app: IO_APP, verifiedAt: null } } },
        { identities: { some: { scheme: IDENTITY_SCHEME.WALLET } } },
      ],
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      identities: { select: { scheme: true, email: true, value: true, app: true, verifiedAt: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  return accounts.flatMap((account) => {
    const emailIdentity = account.identities.find((i) => i.scheme === IDENTITY_SCHEME.EMAIL && i.app === IO_APP);
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

const welcomeSelect = {
  id: true,
  status: true,
  createdAt: true,
  identities: {
    select: { scheme: true, email: true, value: true, app: true, verifiedAt: true, address: true, isPrimary: true, createdAt: true },
  },
} as const;

type WelcomeAccountRow = {
  id: string;
  status: "PENDING" | "ACTIVE" | "INACTIVE";
  createdAt: Date;
  identities: Array<{
    scheme: string;
    email: string | null;
    value: string | null;
    app: string | null;
    verifiedAt: Date | null;
    address: string | null;
    isPrimary: boolean;
    createdAt: Date;
  }>;
};

export function toWelcomeCandidate(account: WelcomeAccountRow): WelcomeCandidate | null {
  const emailIdentity = account.identities.find((i) => i.scheme === IDENTITY_SCHEME.EMAIL && i.app === IO_APP);
  const email = emailIdentity?.email ?? emailIdentity?.value ?? null;
  const wallets = account.identities
    .filter((i) => i.scheme === IDENTITY_SCHEME.WALLET && i.address)
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.createdAt.getTime() - b.createdAt.getTime());
  const wallet = wallets[0]?.address ?? null;
  if (!emailIdentity || !email || !wallet) return null;
  return {
    accountId: account.id,
    email,
    walletAddress: wallet,
    createdAt: account.createdAt,
    facts: {
      status: account.status,
      createdAt: account.createdAt,
      isIo: true,
      hasEmail: true,
      emailVerified: emailIdentity.verifiedAt !== null,
      hasWallet: true,
    },
  };
}

export const welcomeAccountWhere = (accountId: string) => ({ id: accountId });

export const welcomeSweepWhere = (now: Date) => ({
  status: { not: "INACTIVE" as const },
  createdAt: { gt: new Date(now.getTime() - IO_VERIFICATION_DAYS * DAY_MS) },
  notices: { none: { kind: "welcome" } },
  AND: [
    { identities: { some: { scheme: IDENTITY_SCHEME.EMAIL, app: IO_APP } } },
    { identities: { some: { scheme: IDENTITY_SCHEME.WALLET } } },
    {
      OR: [
        { status: "PENDING" as const },
        { identities: { some: { scheme: IDENTITY_SCHEME.EMAIL, app: IO_APP, verifiedAt: { not: null } } } },
      ],
    },
  ],
});

async function findWelcomeCandidates(now: Date, limit: number): Promise<WelcomeCandidate[]> {
  const accounts = await prisma.account.findMany({
    where: welcomeSweepWhere(now),
    select: welcomeSelect,
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  return accounts.flatMap((account) => toWelcomeCandidate(account as WelcomeAccountRow) ?? []);
}

async function loadWelcomeCandidate(accountId: string): Promise<WelcomeCandidate | null> {
  const account = await prisma.account.findFirst({
    where: welcomeAccountWhere(accountId),
    select: welcomeSelect,
  });
  return account ? toWelcomeCandidate(account as WelcomeAccountRow) : null;
}

export function productionSweepDeps(): SweepDeps {
  return {
    findReminderCandidates,
    findWelcomeCandidates,
    loadWelcomeCandidate,
    stillUnverified: async (accountId) => {
      const count = await prisma.identity.count({
        where: { accountId, scheme: IDENTITY_SCHEME.EMAIL, verifiedAt: null },
      });
      return count > 0;
    },
    store: prismaNoticeStore,
    send: sendEmail,
    confirmToken: (accountId, email, deadline) =>
      issueConfirmToken(env.SIWS_SECRET, { accountId, email, expiresAt: deadline }),
    now: () => new Date(),
    batchLimit: 200,
  };
}
