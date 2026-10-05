import prisma from "../db/client.js";
import { IDENTITY_SCHEME } from "./identity.js";

export interface EmailIdentityInfo {
  verifiedAt: Date | null;
  createdAt: Date;
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

export function shouldAddEmailIdentity(input: { emailHeldByAnyAccount: boolean; accountHasEmail: boolean }): boolean {
  return !input.emailHeldByAnyAccount && !input.accountHasEmail;
}
