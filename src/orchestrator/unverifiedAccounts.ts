import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:unverified-accounts");

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
import { DAY_MS, IO_VERIFICATION_DAYS } from "../utils/accountLifecycle.js";
import { IO_APP } from "../utils/caller.js";
import { IDENTITY_SCHEME } from "../utils/identity.js";

export { IO_VERIFICATION_DAYS, verificationDeadline } from "../utils/accountLifecycle.js";

interface AccountUpdater {
  account: {
    updateMany(args: {
      where: {
        status: "PENDING";
        createdAt: { lt: Date };
        identities: { some: { scheme: string; appId: string } };
      };
      data: { status: "INACTIVE" };
    }): Promise<{ count: number }>;
  };
}

export function isExpired(createdAt: Date, now: Date = new Date(), days: number = IO_VERIFICATION_DAYS): boolean {
  return now.getTime() - createdAt.getTime() > days * DAY_MS;
}

export async function deactivateExpiredPending(
  now: Date = new Date(),
  db: AccountUpdater = prisma as unknown as AccountUpdater,
  ioApp: string = IO_APP,
): Promise<number> {
  const cutoff = new Date(now.getTime() - IO_VERIFICATION_DAYS * DAY_MS);
  const { count } = await db.account.updateMany({
    where: {
      status: "PENDING",
      createdAt: { lt: cutoff },
      identities: { some: { scheme: IDENTITY_SCHEME.EMAIL, appId: ioApp } },
    },
    data: { status: "INACTIVE" },
  });
  if (count > 0) log.info({ count }, "Pending io signups that never verified their email are now inactive");
  return count;
}

export async function startUnverifiedAccountsLoop(): Promise<void> {
  for (;;) {
    try {
      await deactivateExpiredPending();
    } catch (err) {
      log.error({ err }, "Deactivating expired pending accounts failed");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
