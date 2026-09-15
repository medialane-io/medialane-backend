import type { Chain, LaunchpadRunStatus, Prisma } from "@prisma/client";
import prisma from "../db/client.js";
import { IDENTITY_SCHEME } from "../utils/identity.js";
import { debitCredits, type CreditsDb } from "../payments/credits.js";
import type { RunQuote } from "./quote.js";

export interface StoredRun {
  id: string;
  apiClientId: string;
  service: string;
  status: LaunchpadRunStatus;
  spec: unknown;
  quote: unknown;
  creditsHeld: number;
  creditsSpent: number;
  progress: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export type CheckoutOutcome = "paid" | "insufficient" | "not-draft";

export interface RunStore {
  create(input: { apiClientId: string; service: string; spec: unknown }): Promise<StoredRun>;
  updateDraft(id: string, apiClientId: string, spec: unknown): Promise<StoredRun | null>;
  get(id: string, apiClientId: string): Promise<StoredRun | null>;
  list(apiClientId: string): Promise<StoredRun[]>;
  cancelDraft(id: string, apiClientId: string): Promise<StoredRun | null>;
  countProvisioned(guests: string[]): Promise<number>;
  checkout(input: {
    id: string;
    apiClientId: string;
    service: string;
    quote: RunQuote;
    paymentId?: string;
    path: string;
  }): Promise<CheckoutOutcome>;
  findPayment(txHash: string, apiClientId: string): Promise<string | null>;
  balance(apiClientId: string): Promise<number>;
}

const runSelect = {
  id: true,
  apiClientId: true,
  service: true,
  status: true,
  spec: true,
  quote: true,
  creditsHeld: true,
  creditsSpent: true,
  progress: true,
  createdAt: true,
  updatedAt: true,
} as const;

class CheckoutAbort extends Error {
  constructor(readonly outcome: CheckoutOutcome) {
    super(outcome);
  }
}

export const prismaRunStore: RunStore = {
  create: ({ apiClientId, service, spec }) =>
    prisma.launchpadRun.create({
      data: { apiClientId, service, spec: spec as Prisma.InputJsonValue },
      select: runSelect,
    }),

  async updateDraft(id, apiClientId, spec) {
    const res = await prisma.launchpadRun.updateMany({
      where: { id, apiClientId, status: "DRAFT" },
      data: { spec: spec as Prisma.InputJsonValue },
    });
    if (res.count === 0) return null;
    return prisma.launchpadRun.findUnique({ where: { id }, select: runSelect });
  },

  get: (id, apiClientId) => prisma.launchpadRun.findFirst({ where: { id, apiClientId }, select: runSelect }),

  list: (apiClientId) =>
    prisma.launchpadRun.findMany({
      where: { apiClientId },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: runSelect,
    }),

  async cancelDraft(id, apiClientId) {
    const res = await prisma.launchpadRun.updateMany({
      where: { id, apiClientId, status: "DRAFT" },
      data: { status: "CANCELLED" },
    });
    if (res.count === 0) return null;
    return prisma.launchpadRun.findUnique({ where: { id }, select: runSelect });
  },

  async countProvisioned(guests) {
    if (guests.length === 0) return 0;
    const identities = await prisma.identity.findMany({
      where: { scheme: IDENTITY_SCHEME.EMAIL, value: { in: guests } },
      select: { accountId: true },
    });
    const accountIds = [...new Set(identities.map((i) => i.accountId))];
    if (accountIds.length === 0) return 0;
    const withWallet = await prisma.identity.findMany({
      where: {
        accountId: { in: accountIds },
        chain: "STARKNET" as Chain,
        scheme: IDENTITY_SCHEME.WALLET,
        address: { not: null },
      },
      distinct: ["accountId"],
      select: { accountId: true },
    });
    const walletAccounts = new Set(withWallet.map((w) => w.accountId));
    return identities.filter((i) => walletAccounts.has(i.accountId)).length;
  },

  async checkout({ id, apiClientId, service, quote, paymentId, path }) {
    try {
      await prisma.$transaction(async (tx) => {
        const moved = await tx.launchpadRun.updateMany({
          where: { id, apiClientId, status: "DRAFT" },
          data: {
            status: "PAID",
            quote: quote as unknown as Prisma.InputJsonValue,
            creditsHeld: quote.total,
            paymentId: paymentId ?? null,
          },
        });
        if (moved.count === 0) throw new CheckoutAbort("not-draft");

        const paid = await debitCredits(apiClientId, quote.total, tx as unknown as CreditsDb);
        if (!paid) throw new CheckoutAbort("insufficient");

        for (const line of quote.lines) {
          await tx.usageEvent.create({
            data: {
              apiClientId,
              actionKey: line.action,
              chain: "STARKNET",
              service,
              unitCredits: line.unitCredits,
              units: line.units,
              credits: line.credits,
              method: "POST",
              path,
              status: 200,
            },
          });
        }
      });
      return "paid";
    } catch (err) {
      if (err instanceof CheckoutAbort) return err.outcome;
      throw err;
    }
  },

  async findPayment(txHash, apiClientId) {
    const payment = await prisma.payment.findFirst({
      where: { txHash, apiClientId, status: "SETTLED" },
      select: { id: true },
    });
    return payment?.id ?? null;
  },

  async balance(apiClientId) {
    const client = await prisma.apiClient.findUnique({ where: { id: apiClientId }, select: { creditBalance: true } });
    return client?.creditBalance ?? 0;
  },
};
