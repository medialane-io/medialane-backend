export interface ClerkRow {
  clerkUserId: string;
  email: string;
}

export interface ClerkIdentity {
  accountId: string;
  tenantId: string;
}

export type BackfillOutcome =
  | { kind: "create"; accountId: string; tenantId: string; email: string }
  | { kind: "already_linked"; accountId: string; email: string }
  | { kind: "conflict"; email: string; clerkAccountId: string; otherAccountId: string }
  | { kind: "unmatched"; clerkUserId: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function normalizeIdentityValue(scheme: string, value: string): string {
  const trimmed = value.trim();
  if (scheme === "email") return trimmed.toLowerCase();
  if (scheme === "phone") {
    const digits = trimmed.replace(/\D/g, "");
    return digits ? `+${digits}` : "";
  }
  return trimmed;
}

export function planClerkEmailBackfill(
  rows: ClerkRow[],
  clerkIdentities: Map<string, ClerkIdentity>,
  emailOwners: Map<string, string>,
): BackfillOutcome[] {
  const outcomes: BackfillOutcome[] = [];
  const planned = new Map<string, string>();

  for (const row of rows) {
    const email = normalizeIdentityValue("email", row.email);
    if (!EMAIL_RE.test(email)) continue;

    const clerk = clerkIdentities.get(row.clerkUserId.trim());
    if (!clerk) {
      outcomes.push({ kind: "unmatched", clerkUserId: row.clerkUserId });
      continue;
    }

    const owner = emailOwners.get(email) ?? planned.get(email);

    if (owner === clerk.accountId) {
      outcomes.push({ kind: "already_linked", accountId: clerk.accountId, email });
      continue;
    }

    if (owner) {
      outcomes.push({
        kind: "conflict",
        email,
        clerkAccountId: clerk.accountId,
        otherAccountId: owner,
      });
      continue;
    }

    planned.set(email, clerk.accountId);
    outcomes.push({ kind: "create", accountId: clerk.accountId, tenantId: clerk.tenantId, email });
  }

  return outcomes;
}
