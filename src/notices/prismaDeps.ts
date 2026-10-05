import { Prisma } from "@prisma/client";
import prisma from "../db/client.js";
import { env } from "../config/env.js";
import { IDENTITY_SCHEME } from "../utils/identity.js";
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
      identities: { select: { scheme: true, value: true, clientId: true, verifiedAt: true } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  return accounts.flatMap((account) => {
    const emailIdentity = account.identities.find((i) => i.scheme === IDENTITY_SCHEME.EMAIL && i.clientId === ioClientId);
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
    select: { scheme: true, value: true, clientId: true, verifiedAt: true, address: true, createdAt: true },
  },
} as const;

type WelcomeAccountRow = {
  id: string;
  status: "PENDING" | "ACTIVE" | "INACTIVE";
  createdAt: Date;
  identities: Array<{
    scheme: string;
    value: string | null;
    clientId: string;
    verifiedAt: Date | null;
    address: string | null;
    createdAt: Date;
  }>;
};

export function toWelcomeCandidate(account: WelcomeAccountRow, ioClientId: string): WelcomeCandidate | null {
  const emailIdentity = account.identities.find((i) => i.scheme === IDENTITY_SCHEME.EMAIL && i.clientId === ioClientId);
  const email = emailIdentity?.value ?? null;
  const wallets = account.identities
    .filter((i) => i.scheme === IDENTITY_SCHEME.WALLET && i.address)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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

export const welcomeSweepWhere = (now: Date, ioClientId: string) => ({
  status: { not: "INACTIVE" as const },
  createdAt: { gt: new Date(now.getTime() - IO_VERIFICATION_DAYS * DAY_MS) },
  notices: { none: { kind: "welcome" } },
  AND: [
    { identities: { some: { scheme: IDENTITY_SCHEME.EMAIL, clientId: ioClientId } } },
    { identities: { some: { scheme: IDENTITY_SCHEME.WALLET } } },
    {
      OR: [
        { status: "PENDING" as const },
        { identities: { some: { scheme: IDENTITY_SCHEME.EMAIL, clientId: ioClientId, verifiedAt: { not: null } } } },
      ],
    },
  ],
});

async function findWelcomeCandidates(now: Date, limit: number): Promise<WelcomeCandidate[]> {
  const ioClientId = env.IO_CLIENT_ID;
  if (!ioClientId) return [];

  const accounts = await prisma.account.findMany({
    where: welcomeSweepWhere(now, ioClientId),
    select: welcomeSelect,
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  return accounts.flatMap((account) => toWelcomeCandidate(account as WelcomeAccountRow, ioClientId) ?? []);
}

async function loadWelcomeCandidate(accountId: string): Promise<WelcomeCandidate | null> {
  const ioClientId = env.IO_CLIENT_ID;
  if (!ioClientId) return null;
  const account = await prisma.account.findFirst({
    where: welcomeAccountWhere(accountId),
    select: welcomeSelect,
  });
  return account ? toWelcomeCandidate(account as WelcomeAccountRow, ioClientId) : null;
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
