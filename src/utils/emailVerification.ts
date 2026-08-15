import prisma from "../db/client.js";
import { IDENTITY_SCHEME } from "./identity.js";

export interface EmailIdentityInfo {
  verifiedAt: Date | null;
  createdAt: Date;
}

const DEFAULT_GRACE_DAYS = 7;

export function isEmailVerificationRequired(
  identity: EmailIdentityInfo | null,
  graceDays: number = DEFAULT_GRACE_DAYS,
  now: Date = new Date(),
): boolean {
  if (!identity) return false;
  if (identity.verifiedAt) return false;
  const graceMs = graceDays * 24 * 60 * 60 * 1000;
  return now.getTime() - identity.createdAt.getTime() > graceMs;
}

export async function requiresEmailVerification(
  accountId: string,
  graceDays: number = DEFAULT_GRACE_DAYS,
): Promise<boolean> {
  // An account can end up with more than one email Identity row (e.g. the
  // user submits a second email before verifying the first — POST /v1/users/me
  // creates a new row per distinct email value, it never updates or removes
  // an existing one for the account). Prefer a verified row if any exists,
  // since that reflects the account's real current state; among unverified
  // rows, prefer the most recently created one as "the current attempt."
  const identity = await prisma.identity.findFirst({
    where: { accountId, scheme: IDENTITY_SCHEME.EMAIL },
    select: { verifiedAt: true, createdAt: true },
    orderBy: [{ verifiedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  });
  return isEmailVerificationRequired(identity, graceDays);
}
