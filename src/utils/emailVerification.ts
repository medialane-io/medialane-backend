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
  const identity = await prisma.identity.findFirst({
    where: { accountId, scheme: IDENTITY_SCHEME.EMAIL },
    select: { verifiedAt: true, createdAt: true },
  });
  return isEmailVerificationRequired(identity, graceDays);
}
