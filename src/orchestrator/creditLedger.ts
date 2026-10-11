import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:credit-ledger");

const INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 5 * 60 * 1000;

export interface BalanceDifference {
  apiCreditsId: string;
  balance: number;
  ledger: number;
}

export interface PaymentDifference {
  entryId: string;
  paymentId: string | null;
}

export async function findLedgerDifferences(): Promise<{ balances: BalanceDifference[]; payments: PaymentDifference[] }> {
  const balances = await prisma.$queryRaw<BalanceDifference[]>`
    SELECT ac."id" AS "apiCreditsId", ac."creditBalance" AS "balance", COALESCE(SUM(ce."credits"), 0)::int AS "ledger"
    FROM "ApiCredits" ac
    LEFT JOIN "CreditEntry" ce ON ce."apiCreditsId" = ac."id"
    GROUP BY ac."id"
    HAVING ac."creditBalance" <> COALESCE(SUM(ce."credits"), 0)
  `;
  const payments = await prisma.$queryRaw<PaymentDifference[]>`
    SELECT ce."id" AS "entryId", ce."paymentId" AS "paymentId"
    FROM "CreditEntry" ce
    LEFT JOIN "Payment" p ON p."id" = ce."paymentId"
    WHERE ce."kind" = 'PAYMENT' AND (p."id" IS NULL OR p."status" <> 'SETTLED' OR p."txHash" = '')
  `;
  return { balances, payments };
}

export async function startCreditLedgerLoop(): Promise<void> {
  let delay = BOOT_DELAY_MS;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = INTERVAL_MS;
    try {
      const { balances, payments } = await findLedgerDifferences();
      for (const d of balances) log.error(d, "Credit balance differs from its ledger");
      for (const d of payments) log.error(d, "PAYMENT entry without a settled payment");
      log.info({ balances: balances.length, payments: payments.length }, "Credit ledger reconciled");
    } catch (err) {
      log.error({ err }, "Credit ledger reconciliation failed");
    }
  }
}
