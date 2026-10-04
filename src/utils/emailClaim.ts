import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";
import { IDENTITY_SCHEME, emailValues } from "./identity.js";

const log = createLogger("utils:email-claim");

export interface ClaimableIdentity {
  id: string;
  accountId: string;
  verifiedAt: Date | null;
  accountStatus: "ACTIVE" | "PENDING" | "INACTIVE";
}

export function claimOutcome(identity: ClaimableIdentity | null): "none" | "own" | "release" {
  if (!identity) return "none";
  if (identity.verifiedAt) return "own";
  return identity.accountStatus === "INACTIVE" ? "release" : "own";
}

export async function releaseAbandonedEmail(email: string, clientId: string): Promise<boolean> {
  const identity = await prisma.identity.findFirst({
    where: {
      clientId,
      scheme: IDENTITY_SCHEME.EMAIL,
      value: { in: emailValues(email) },
    },
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
    { accountId: identity!.accountId, clientId },
    "Released an email from an account that never verified it",
  );
  return true;
}
