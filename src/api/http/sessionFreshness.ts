import prisma from "../../db/client.js";

export interface SessionFreshnessDeps {
  /** When the account's email was verified (it became ACTIVE from PENDING), or null if it never was pending. */
  verifiedAt(accountId: string): Promise<Date | null>;
}

export const productionSessionFreshnessDeps: SessionFreshnessDeps = {
  verifiedAt: async (accountId) => {
    const event = await prisma.accountEvent.findFirst({
      where: { accountId, type: "STATUS_CHANGED", data: { path: ["to"], equals: "ACTIVE" } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return event?.createdAt ?? null;
  },
};

/**
 * Sessions issued up to this long before the recorded verification still count as fresh. Token times are whole
 * seconds from the app server while the verification time comes from the database, so the two can disagree
 * slightly; a session that verification itself issues must never look older than it.
 */
const CLOCK_TOLERANCE_SECONDS = 60;

/** True when the session (issued at `issuedAt`, in seconds) was issued before the account's email was verified. */
export async function sessionPredatesVerification(
  accountId: string,
  issuedAt: number,
  deps: SessionFreshnessDeps = productionSessionFreshnessDeps,
): Promise<boolean> {
  const verified = await deps.verifiedAt(accountId);
  if (!verified) return false;
  return issuedAt < Math.floor(verified.getTime() / 1000) - CLOCK_TOLERANCE_SECONDS;
}
