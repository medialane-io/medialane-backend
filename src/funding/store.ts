import { Prisma } from "@prisma/client";
import prisma from "../db/client.js";
import { PAYMENT_GRACE_MS } from "./core.js";
import type { FundingIntentRecord, FundingStore, SettleInput, SettleOutcome } from "./types.js";

const select = {
  id: true,
  apiCreditsId: true,
  method: true,
  status: true,
  payer: true,
  params: true,
  expiresAt: true,
} as const;

type Row = {
  id: string;
  apiCreditsId: string;
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

  async create(input) {
    const row = await prisma.fundingIntent.create({
      data: {
        apiCreditsId: input.apiCreditsId,
        method: input.method,
        params: input.params as Prisma.InputJsonValue,
        expiresAt: input.expiresAt,
      },
      select,
    });
    return toRecord(row);
  },

  async get(id, apiCreditsId) {
    const row = await prisma.fundingIntent.findFirst({ where: { id, apiCreditsId }, select });
    return row ? toRecord(row) : null;
  },

  async setPayer(id, apiCreditsId, payer, now) {
    const res = await prisma.fundingIntent.updateMany({
      where: { id, apiCreditsId, status: "PENDING", payer: null, expiresAt: { gt: now } },
      data: { payer },
    });
    return res.count === 1;
  },

  async openForPayer(payer, now) {
    const rows = await prisma.fundingIntent.findMany({
      where: { payer, status: "PENDING", expiresAt: { gt: new Date(now.getTime() - PAYMENT_GRACE_MS) } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select,
    });
    return rows.map(toRecord);
  },

  async cancel(id, apiCreditsId) {
    const res = await prisma.fundingIntent.updateMany({
      where: { id, apiCreditsId, status: "PENDING" },
      data: { status: "EXPIRED" },
    });
    return res.count === 1;
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
            apiCreditsId: intent.apiCreditsId,
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
        await tx.apiCredits.update({
          where: { id: intent.apiCreditsId },
          data: { creditBalance: { increment: credited } },
        });
        return { outcome: "settled", paymentId: payment.id } as const;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return { outcome: "duplicate" };
      }
      throw err;
    }
  },
};
