import type { LaunchpadRunStatus, Prisma } from "@prisma/client";
import prisma from "../db/client.js";
import { IDENTITY_SCHEME } from "../utils/identity.js";
import { normalizeAddress } from "../utils/starknet.js";
import { debitCredits, refundCredits, type CreditsDb } from "../payments/credits.js";
import type { RunQuote } from "./steps.js";
import { resolveRecipientWallets } from "../utils/recipientWallets.js";

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
    progress: unknown;
    path: string;
  }): Promise<CheckoutOutcome>;
  balance(apiClientId: string): Promise<number>;
  reserve(input: {
    id: string;
    apiClientId: string;
    credits: number;
    path: string[];
    retryReverted?: boolean;
  }): Promise<boolean>;
  record(id: string, apiClientId: string, path: string[], value: unknown): Promise<void>;
  release(input: { id: string; apiClientId: string; credits: number; path: string[] }): Promise<void>;
  ownsWallet(accountId: string, address: string): Promise<boolean>;
  complete(input: {
    id: string;
    apiClientId: string;
    status: "COMPLETED" | "CANCELLED";
    path: string;
  }): Promise<{ refunded: number } | null>;
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
    const wallets = await resolveRecipientWallets("STARKNET", IDENTITY_SCHEME.EMAIL, guests);
    return wallets.filter((w) => w.walletAddress !== null).length;
  },

  async checkout({ id, apiClientId, service, quote, paymentId, progress, path }) {
    try {
      await prisma.$transaction(async (tx) => {
        const moved = await tx.launchpadRun.updateMany({
          where: { id, apiClientId, status: "DRAFT" },
          data: {
            status: "PAID",
            quote: quote as unknown as Prisma.InputJsonValue,
            creditsHeld: quote.total,
            paymentId: paymentId ?? null,
            progress: progress as Prisma.InputJsonValue,
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

  async balance(apiClientId) {
    const client = await prisma.apiClient.findUnique({ where: { id: apiClientId }, select: { creditBalance: true } });
    return client?.creditBalance ?? 0;
  },

  async reserve({ id, apiClientId, credits, path, retryReverted }) {
    const statusPath = [...path, "status"];
    const count = await prisma.$executeRaw`
      UPDATE "LaunchpadRun"
      SET "creditsSpent" = "creditsSpent" + ${credits},
          "status" = 'RUNNING',
          "progress" = jsonb_set("progress", ${path}::text[], '{"status":"PENDING"}'::jsonb, true),
          "updatedAt" = now()
      WHERE "id" = ${id}
        AND "apiClientId" = ${apiClientId}
        AND "status" IN ('PAID', 'RUNNING')
        AND "creditsSpent" + ${credits} <= "creditsHeld"
        AND (
          "progress" #> ${path}::text[] IS NULL
          OR (${retryReverted ?? false} AND "progress" #>> ${statusPath}::text[] = 'REVERTED')
        )`;
    return count > 0;
  },

  async record(id, apiClientId, path, value) {
    await prisma.$executeRaw`
      UPDATE "LaunchpadRun"
      SET "progress" = jsonb_set("progress", ${path}::text[], ${JSON.stringify(value)}::jsonb, true),
          "updatedAt" = now()
      WHERE "id" = ${id} AND "apiClientId" = ${apiClientId}`;
  },

  async release({ id, apiClientId, credits, path }) {
    await prisma.$executeRaw`
      UPDATE "LaunchpadRun"
      SET "creditsSpent" = GREATEST("creditsSpent" - ${credits}, 0),
          "progress" = "progress" #- ${path}::text[],
          "updatedAt" = now()
      WHERE "id" = ${id} AND "apiClientId" = ${apiClientId}`;
  },

  async complete({ id, apiClientId, status, path }) {
    return prisma.$transaction(async (tx) => {
      const run = await tx.launchpadRun.findFirst({
        where: { id, apiClientId, status: { in: ["PAID", "RUNNING"] } },
        select: { service: true, creditsHeld: true, creditsSpent: true },
      });
      if (!run) return null;

      const moved = await tx.launchpadRun.updateMany({
        where: { id, apiClientId, status: { in: ["PAID", "RUNNING"] } },
        data: { status },
      });
      if (moved.count === 0) return null;

      const refunded = Math.max(0, run.creditsHeld - run.creditsSpent);
      if (refunded > 0) {
        await refundCredits(apiClientId, refunded, tx as unknown as CreditsDb);
        await tx.usageEvent.create({
          data: {
            apiClientId,
            actionKey: "launchpad:refund",
            chain: "STARKNET",
            service: run.service,
            unitCredits: -refunded,
            units: 1,
            credits: -refunded,
            method: "POST",
            path,
            status: 200,
          },
        });
      }
      return { refunded };
    });
  },

  async ownsWallet(accountId, address) {
    let normalized: string;
    try {
      normalized = normalizeAddress("STARKNET", address);
    } catch {
      return false;
    }
    const wallet = await prisma.identity.findFirst({
      where: { accountId, chain: "STARKNET", scheme: IDENTITY_SCHEME.WALLET, address: normalized },
      select: { id: true },
    });
    return wallet !== null;
  },
};
