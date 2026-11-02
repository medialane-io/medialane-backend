import type { Context } from "hono";
import prisma from "../../db/client.js";
import type { AppEnv } from "../../types/hono.js";

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

/** True when the session (issued at `issuedAt`, in seconds) was issued before the account's email was verified. */
export async function sessionPredatesVerification(
  accountId: string,
  issuedAt: number,
  deps: SessionFreshnessDeps = productionSessionFreshnessDeps,
): Promise<boolean> {
  const verified = await deps.verifiedAt(accountId);
  return verified !== null && issuedAt * 1000 < verified.getTime();
}

const SIGN_IN_AGAIN = { error: "Sign in again to make this change", code: "sign_in_again" } as const;

/**
 * Refuses an account or wallet change made with an account session issued before the account was verified.
 * Requests not authenticated by an account session (wallet signatures, API keys) are not checked.
 */
export async function refuseStaleSession(
  c: Context<AppEnv>,
  deps: SessionFreshnessDeps = productionSessionFreshnessDeps,
): Promise<Response | null> {
  const accountId = c.get("sessionAccountId");
  const issuedAt = c.get("sessionIssuedAt");
  if (!accountId || issuedAt === undefined) return null;
  return (await sessionPredatesVerification(accountId, issuedAt, deps)) ? c.json(SIGN_IN_AGAIN, 403) : null;
}
