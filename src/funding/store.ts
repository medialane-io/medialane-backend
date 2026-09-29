import { Prisma } from "@prisma/client";
import prisma from "../db/client.js";
import type { FundingIntentRecord, FundingStore, SettleInput, SettleOutcome } from "./types.js";

const select = {
  id: true,
  apiClientId: true,
  method: true,
  status: true,
  payer: true,
  params: true,
  expiresAt: true,
} as const;

type Row = {
  id: string;
  apiClientId: string;
  method: string;
  status: FundingIntentRecord["status"];
  payer: string | null;
  params: Prisma.JsonValue;
  expiresAt: Date;
};

const toRecord = (row: Row): FundingIntentRecord => ({
  ...row,
  params: (row.params ?? {}) as Record<string, unknown>,
});

export const prismaFundingStore: FundingStore = {
  countOpen(apiClientId, now) {
    return prisma.fundingIntent.count({
      where: {
        apiClientId,
        status: "PENDING",
        OR: [{ payer: { not: null } }, { expiresAt: { gt: now } }],
      },
    });
  },

  async create(input) {
    const row = await prisma.fundingIntent.create({
      data: {
        apiClientId: input.apiClientId,
        method: input.method,
        params: input.params as Prisma.InputJsonValue,
        expiresAt: input.expiresAt,
      },
      select,
    });
    return toRecord(row);
  },

  async get(id, apiClientId) {
    const row = await prisma.fundingIntent.findFirst({ where: { id, apiClientId }, select });
    return row ? toRecord(row) : null;
  },

  async setPayer(id, apiClientId, payer, now) {
    const res = await prisma.fundingIntent.updateMany({
      where: { id, apiClientId, status: "PENDING", payer: null, expiresAt: { gt: now } },
      data: { payer },
    });
    return res.count === 1;
  },

  async openForPayer(payer) {
    const rows = await prisma.fundingIntent.findMany({
      where: { payer, status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select,
    });
    return rows.map(toRecord);
  },

  async settle({ intent, verified, credited, multiplier }: SettleInput): Promise<SettleOutcome> {
    try {
      return await prisma.$transaction(async (tx) => {
        const claimed = await tx.fundingIntent.updateMany({
          where: { id: intent.id, status: "PENDING" },
          data: { status: "SETTLED", settledAt: new Date() },
        });
        if (claimed.count === 0) return { outcome: "not-open" } as const;

        const payment = await tx.payment.create({
          data: {
            apiClientId: intent.apiClientId,
            fundingIntentId: intent.id,
            payer: verified.payer,
            scheme: verified.scheme,
            network: verified.network,
            asset: verified.asset,
            amountAtomic: verified.valueUsdcAtomic.toString(),
            creditedAmount: credited,
            mdlnMultiplier: multiplier,
            status: "SETTLED",
            txHash: verified.txHash,
            proofNonce: verified.proofNonce,
          },
          select: { id: true },
        });
        await tx.apiClient.update({
          where: { id: intent.apiClientId },
          data: { creditBalance: { increment: credited } },
        });
        return { outcome: "settled", paymentId: payment.id } as const;
      });
    } catch (err) {
      // The transfer was already credited (proofNonce is unique): the whole transaction rolls back,
      // so the intent stays PENDING and nothing is counted twice.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return { outcome: "duplicate" };
      }
      throw err;
    }
  },
};
