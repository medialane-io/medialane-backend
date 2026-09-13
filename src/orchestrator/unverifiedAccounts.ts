import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";
import { IDENTITY_SCHEME } from "../utils/identity.js";
import { DEFAULT_GRACE_DAYS } from "../utils/emailVerification.js";

const log = createLogger("orchestrator:unverified-accounts");

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const RULE_STARTS_AT = new Date("2026-09-13T00:00:00.000Z");

export function deadlineFor(registeredAt: Date, graceDays: number = DEFAULT_GRACE_DAYS): Date {
  return new Date(registeredAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
}

export function isPastDue(
  registeredAt: Date,
  now: Date = new Date(),
  graceDays: number = DEFAULT_GRACE_DAYS,
  ruleStartsAt: Date = RULE_STARTS_AT,
): boolean {
  if (registeredAt < ruleStartsAt) return false;
  return now > deadlineFor(registeredAt, graceDays);
}

export function graceCutoff(now: Date = new Date(), graceDays: number = DEFAULT_GRACE_DAYS): Date {
  return new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);
}

export async function suspendUnverifiedAccounts(now: Date = new Date()): Promise<number> {
  const cutoff = graceCutoff(now);

  const candidates = await prisma.identity.findMany({
    where: {
      scheme: IDENTITY_SCHEME.EMAIL,
      verifiedAt: null,
      createdAt: { lt: cutoff },
      account: { status: "ACTIVE" },
    },
    select: { accountId: true, createdAt: true },
  });
  const stale = candidates.filter((row) => isPastDue(row.createdAt, now));
  if (stale.length === 0) return 0;

  const verified = await prisma.identity.findMany({
    where: {
      accountId: { in: stale.map((row) => row.accountId) },
      scheme: IDENTITY_SCHEME.EMAIL,
      verifiedAt: { not: null },
    },
    select: { accountId: true },
  });
  const keep = new Set(verified.map((row) => row.accountId));
  const toSuspend = [...new Set(stale.map((row) => row.accountId))].filter((id) => !keep.has(id));
  if (toSuspend.length === 0) return 0;

  const { count } = await prisma.account.updateMany({
    where: { id: { in: toSuspend }, status: "ACTIVE" },
    data: { status: "SUSPENDED" },
  });

  log.info({ count, graceDays: DEFAULT_GRACE_DAYS }, "Suspended accounts whose email was never verified");
  return count;
}

export async function startUnverifiedAccountsLoop(): Promise<void> {
  for (;;) {
    try {
      await suspendUnverifiedAccounts();
    } catch (err) {
      log.error({ err }, "Suspending unverified accounts failed");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
