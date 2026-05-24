import prisma from "../db/client.js";
import { normalizeAddress } from "./starknet.js";
import type { Chain, IdentityProvider, AppSource, WalletType } from "@prisma/client";

/**
 * Resolves a (chain, address) wallet to its Account.id.
 * Returns null if no Wallet row exists for this address.
 *
 * Address is normalized before lookup — callers may pass raw input.
 */
export async function resolveAccountIdFromWallet(
  chain: Chain,
  address: string,
): Promise<string | null> {
  const normalized = normalizeAddress(address);
  const wallet = await prisma.wallet.findUnique({
    where: { chain_address: { chain, address: normalized } },
    select: { accountId: true },
  });
  return wallet?.accountId ?? null;
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
 * Idempotent: if a Wallet row exists for (chain, address), returns its accountId.
 * Otherwise creates an Account + Wallet + Identity + empty AccountProfile (one transaction)
 * and returns the new accountId.
 *
 * This is the single entry point the onboarding route uses. Do not call from read-only paths.
 *
 * If the wallet already exists with walletType=UNKNOWN and a more specific type is provided,
 * the row is upgraded — this is how the onboarding fix lifts the 48 "UNKNOWN" rows out of
 * undifferentiated state over time.
 */
export async function ensureAccountForWallet(params: {
  chain: Chain;
  address: string;
  walletType: WalletType;
  appSource: AppSource;
  identityProvider?: IdentityProvider;
  email?: string;
}): Promise<{ accountId: string; walletId: string; created: boolean }> {
  const address = normalizeAddress(params.address);
  const existing = await prisma.wallet.findUnique({
    where: { chain_address: { chain: params.chain, address } },
    select: { id: true, accountId: true, walletType: true },
  });

  if (existing) {
    if (existing.walletType === "UNKNOWN" && params.walletType !== "UNKNOWN") {
      await prisma.wallet.update({
        where: { id: existing.id },
        data: { walletType: params.walletType },
      });
    }
    // Backfill a CLERK Identity for medialane-io accounts that pre-date the
    // dual-identity change. Idempotent via the (provider, providerUserId) unique key.
    if (params.appSource === "MEDIALANE_IO") {
      await ensureClerkIdentity(existing.accountId, address, params.email);
    }
    return { accountId: existing.accountId, walletId: existing.id, created: false };
  }

  const provider = params.identityProvider ?? "WALLET";
  const providerUserId =
    provider === "WALLET"
      ? `wallet:${params.chain}:${address}`
      : `${params.appSource}:${address}`;

  const result = await prisma.$transaction(async (tx) => {
    let account: { id: string } | null = null;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        account = await tx.account.create({
          data: {
            publicId: generateAccountPublicId(),
            type: "PERSON",
            roles: [],
          },
          select: { id: true },
        });
        break;
      } catch (e: unknown) {
        lastErr = e;
      }
    }
    if (!account) throw lastErr ?? new Error("Failed to allocate Account publicId");

    const wallet = await tx.wallet.create({
      data: {
        accountId: account.id,
        chain: params.chain,
        address,
        walletType: params.walletType,
        isPrimary: true,
      },
      select: { id: true },
    });

    await tx.identity.create({
      data: {
        accountId: account.id,
        provider,
        providerUserId,
        appSource: params.appSource,
        email: params.email ?? null,
      },
    });

    // A medialane-io user authenticates via Clerk AND has a ChipiPay/Privy wallet.
    // The wallet-provider Identity above captures the wallet provenance; this second
    // Identity captures the auth provenance. They're distinct facets — see
    // medialane-core/docs/architecture/07-identity-model.md.
    if (params.appSource === "MEDIALANE_IO" && provider !== "CLERK") {
      await tx.identity.create({
        data: {
          accountId: account.id,
          provider: "CLERK",
          providerUserId: `MEDIALANE_IO:clerk:${address}`,
          appSource: params.appSource,
          email: params.email ?? null,
        },
      });
    }

    await tx.accountProfile.create({
      data: { accountId: account.id },
    });

    return { accountId: account.id, walletId: wallet.id };
  });

  return { ...result, created: true };
}

/**
 * Idempotently ensure a CLERK Identity row exists for this Account. Used to
 * backfill pre-existing medialane-io accounts that were created before the
 * dual-Identity change; safe to call on every login.
 */
async function ensureClerkIdentity(
  accountId: string,
  address: string,
  email?: string,
): Promise<void> {
  const providerUserId = `MEDIALANE_IO:clerk:${address}`;
  const existing = await prisma.identity.findUnique({
    where: { provider_providerUserId: { provider: "CLERK", providerUserId } },
    select: { id: true },
  });
  if (existing) return;
  try {
    await prisma.identity.create({
      data: {
        accountId,
        provider: "CLERK",
        providerUserId,
        appSource: "MEDIALANE_IO",
        email: email ?? null,
      },
    });
  } catch {
    // Race-safe: a concurrent caller may have inserted the row; the unique key
    // protects us. Swallow — the desired end-state is achieved either way.
  }
}
