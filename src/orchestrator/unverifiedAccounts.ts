import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:unverified-accounts");

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
import { DAY_MS, IO_VERIFICATION_DAYS } from "../utils/accountLifecycle.js";
import { IO_APP } from "../utils/caller.js";
import { IDENTITY_SCHEME } from "../utils/identity.js";
import { recordAccountEvent } from "../utils/accountEvents.js";

export { IO_VERIFICATION_DAYS, verificationDeadline } from "../utils/accountLifecycle.js";

export function isExpired(createdAt: Date, now: Date = new Date(), days: number = IO_VERIFICATION_DAYS): boolean {
  return now.getTime() - createdAt.getTime() > days * DAY_MS;
}

export async function deactivateExpiredPending(now: Date = new Date(), ioApp: string = IO_APP): Promise<number> {
  const cutoff = new Date(now.getTime() - IO_VERIFICATION_DAYS * DAY_MS);
  const count = await prisma.$transaction(async (tx) => {
    const deactivated = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "Account" a SET status = 'INACTIVE', "updatedAt" = NOW()
      WHERE a.status = 'PENDING'
        AND a."createdAt" < ${cutoff}
        AND EXISTS (
          SELECT 1 FROM "Identity" i
          WHERE i."accountId" = a.id AND i.scheme = ${IDENTITY_SCHEME.EMAIL} AND i."appId" = ${ioApp}
        )
      RETURNING a.id
    `;
    for (const { id } of deactivated) {
      await recordAccountEvent(tx, id, "STATUS_CHANGED", { from: "PENDING", to: "INACTIVE" });
    }
    return deactivated.length;
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
