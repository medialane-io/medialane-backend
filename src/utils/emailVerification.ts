import prisma from "../db/client.js";
import { IDENTITY_SCHEME } from "./identity.js";

export interface EmailIdentityInfo {
  createdAt: Date;
}

export interface CurrentEmailIdentity extends EmailIdentityInfo {
  email: string | null;
}

export async function getCurrentEmailIdentity(accountId: string): Promise<CurrentEmailIdentity | null> {
  const identity = await prisma.identity.findFirst({
    where: { accountId, scheme: IDENTITY_SCHEME.EMAIL },
    select: { value: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return identity && { email: identity.value, createdAt: identity.createdAt };
}

export interface EmailClaimDecision {
  allowed: boolean;
  reason: "already-yours" | "held-elsewhere" | null;
}

export function canClaimEmail(
  callerAccountId: string,
  existingOwner: { accountId: string } | null,
): EmailClaimDecision {
  if (!existingOwner) return { allowed: true, reason: null };
  if (existingOwner.accountId === callerAccountId) {
    return { allowed: false, reason: "already-yours" };
  }
  return { allowed: false, reason: "held-elsewhere" };
}

export function shouldAddEmailIdentity(input: { emailHeldByAnyAccount: boolean; accountHasEmail: boolean }): boolean {
  return !input.emailHeldByAnyAccount && !input.accountHasEmail;
}
