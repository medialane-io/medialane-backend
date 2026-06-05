import prisma from "../db/client.js";
import { normalizeAddress } from "./starknet.js";
import type { Chain, AppSource } from "@prisma/client";

/**
 * Resolves a (chain, address) wallet to its Account.id.
 * Returns null if no wallet Identity exists for this address.
 *
 * A wallet is one kind of Identity (scheme="wallet"), keyed by its (chain, address).
 * Address is normalized before lookup — callers may pass raw input.
 */
export async function resolveAccountIdFromWallet(
  chain: Chain,
  address: string,
): Promise<string | null> {
  const normalized = normalizeAddress(address);
  const identity = await prisma.identity.findUnique({
    where: { chain_address: { chain, address: normalized } },
    select: { accountId: true },
  });
  return identity?.accountId ?? null;
}

/**
 * Generates a user-facing account handle.
 * Format: "acc_" + 12 Crockford base32 chars (no I/L/O/U).
 * Collision is the caller's responsibility — Account.publicId is @unique.
 */
export function generateAccountPublicId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "acc_";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (const b of bytes) out += alphabet[b % 32];
  return out;
}

/**
 * Adds a role to Account.roles atomically. Race-safe under concurrent calls.
 *
 * Why raw SQL: Prisma's `roles: { set: [...account.roles, role] }` requires
 * a read-then-write — two concurrent calls both read `[A]`, both write
 * `[A, B]` vs `[A, C]`, last writer wins and one role is lost. A single
 * `UPDATE ... SET roles = array_append(roles, $1) WHERE NOT (roles @> ...)`
 * statement is atomic and idempotent (the WHERE guard makes a repeat call
 * a no-op).
 */
export async function addAccountRole(
  accountId: string,
  role: "CREATOR" | "COLLECTOR" | "ORGANIZATION" | "AGENT" | "PARTNER",
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Account"
    SET roles = array_append(roles, ${role}::"AccountRole")
    WHERE id = ${accountId}
      AND NOT (roles @> ARRAY[${role}::"AccountRole"])
  `;
}

/**
 * Idempotent: if a wallet Identity exists for (chain, address), returns its accountId.
 * Otherwise creates an Account + wallet Identity + empty AccountProfile (one transaction)
 * and returns the new accountId.
 *
 * This is the single entry point the onboarding routes use. Do not call from read-only paths.
 *
 * `provider` is the free-form wallet-software label ("braavos" / "ready" / "chipipay" / …) —
 * it never gates anything (07-identity §II). If the wallet exists with an "unknown" provider
 * and a specific one is supplied, the label is upgraded.
 *
 * A medialane-io account (appSource MEDIALANE_IO) additionally gets a `clerk` Identity that
 * captures the auth provenance — distinct from the on-chain signer, never conflated (07 §IV).
 */
export async function ensureAccountForWallet(params: {
  chain: Chain;
  address: string;
  provider?: string;
  appSource: AppSource;
  email?: string;
}): Promise<{ accountId: string; created: boolean }> {
  const address = normalizeAddress(params.address);
  const provider = (params.provider ?? "unknown").toLowerCase();
  const isSocial = params.appSource === "MEDIALANE_IO";

  const existing = await prisma.identity.findUnique({
    where: { chain_address: { chain: params.chain, address } },
    select: { id: true, accountId: true, provider: true },
  });

  if (existing) {
    if ((existing.provider === null || existing.provider === "unknown") && provider !== "unknown") {
      await prisma.identity.update({ where: { id: existing.id }, data: { provider } });
    }
    if (isSocial) await ensureClerkIdentity(existing.accountId, address, params.email);
    return { accountId: existing.accountId, created: false };
  }

  const accountId = await prisma.$transaction(async (tx) => {
    let account: { id: string } | null = null;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        account = await tx.account.create({
          data: { publicId: generateAccountPublicId(), type: "PERSON", roles: [] },
          select: { id: true },
        });
        break;
      } catch (e: unknown) {
        lastErr = e;
      }
    }
    if (!account) throw lastErr ?? new Error("Failed to allocate Account publicId");

    // The wallet — the on-chain signer (07 §I): identified by (chain, address).
    await tx.identity.create({
      data: {
        accountId: account.id,
        scheme: "wallet",
        provider,
        chain: params.chain,
        address,
        appSource: params.appSource,
        isPrimary: true,
        email: params.email ?? null,
      },
    });

    // medialane-io: a Clerk-authenticated, ChipiPay-signed account. The wallet Identity
    // above is the on-chain signer; this second Identity is the auth provenance. They're
    // distinct facets — see medialane-core/docs/architecture/07-identity-model.md §IV.
    if (isSocial) {
      await tx.identity.create({
        data: {
          accountId: account.id,
          scheme: "clerk",
          provider: "clerk",
          value: `MEDIALANE_IO:clerk:${address}`,
          appSource: params.appSource,
          email: params.email ?? null,
        },
      });
    }

    await tx.accountProfile.create({ data: { accountId: account.id } });
    return account.id;
  });

  return { accountId, created: true };
}

/**
 * Idempotently ensure a `clerk` Identity exists for this Account. Used to backfill
 * pre-existing medialane-io accounts on login; safe to call every time. Idempotent via
 * the (scheme, value) unique key.
 */
async function ensureClerkIdentity(
  accountId: string,
  address: string,
  email?: string,
): Promise<void> {
  const value = `MEDIALANE_IO:clerk:${address}`;
  const existing = await prisma.identity.findUnique({
    where: { scheme_value: { scheme: "clerk", value } },
    select: { id: true },
  });
  if (existing) return;
  try {
    await prisma.identity.create({
      data: {
        accountId,
        scheme: "clerk",
        provider: "clerk",
        value,
        appSource: "MEDIALANE_IO",
        email: email ?? null,
      },
    });
  } catch {
    // Race-safe: a concurrent caller may have inserted the row; the unique key
    // protects us. Swallow — the desired end-state is achieved either way.
  }
}
