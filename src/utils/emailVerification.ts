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

export interface CurrentEmailIdentity extends EmailIdentityInfo {
  email: string | null;
}

export async function getCurrentEmailIdentity(accountId: string): Promise<CurrentEmailIdentity | null> {
  return prisma.identity.findFirst({
    where: { accountId, scheme: IDENTITY_SCHEME.EMAIL },
    select: { email: true, verifiedAt: true, createdAt: true },
    orderBy: [{ verifiedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  });
}

export async function requiresEmailVerification(
  accountId: string,
  graceDays: number = DEFAULT_GRACE_DAYS,
): Promise<boolean> {
  const identity = await getCurrentEmailIdentity(accountId);
  return isEmailVerificationRequired(identity, graceDays);
}

export interface EmailClaimDecision {
  allowed: boolean;
  reason: "already-yours" | "verified-elsewhere" | null;
}

export function canClaimEmail(
  callerAccountId: string,
  existingOwner: { accountId: string; verifiedAt: Date | null } | null,
): EmailClaimDecision {
  if (!existingOwner) return { allowed: true, reason: null };
  if (existingOwner.accountId === callerAccountId) {
    return { allowed: false, reason: "already-yours" };
  }
  if (existingOwner.verifiedAt) {
    return { allowed: false, reason: "verified-elsewhere" };
  }
  return { allowed: true, reason: null };
}
