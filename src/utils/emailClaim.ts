import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";
import { IDENTITY_SCHEME } from "./identity.js";

const log = createLogger("utils:email-claim");

export interface ClaimableIdentity {
  id: string;
  accountId: string;
  verifiedAt: Date | null;
  accountStatus: "ACTIVE" | "SUSPENDED";
}

export function claimOutcome(identity: ClaimableIdentity | null): "none" | "own" | "release" {
  if (!identity) return "none";
  if (identity.verifiedAt) return "own";
  return identity.accountStatus === "SUSPENDED" ? "release" : "own";
}

export async function releaseAbandonedEmail(email: string, tenantId: string): Promise<boolean> {
  const identity = await prisma.identity.findUnique({
    where: { scheme_value_tenantId: { scheme: IDENTITY_SCHEME.EMAIL, value: email, tenantId } },
    select: {
      id: true,
      accountId: true,
      verifiedAt: true,
      account: { select: { status: true } },
    },
  });

  const outcome = claimOutcome(
    identity && {
      id: identity.id,
      accountId: identity.accountId,
      verifiedAt: identity.verifiedAt,
      accountStatus: identity.account.status,
    },
  );
  if (outcome !== "release") return false;

  await prisma.identity.delete({ where: { id: identity!.id } });
  log.info(
    { accountId: identity!.accountId, tenantId },
    "Released an email from an account that never verified it",
  );
  return true;
}
