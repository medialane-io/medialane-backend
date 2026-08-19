import prisma from "../db/client.js";
import { normalizeAddress } from "./starknet.js";
import { IDENTITY_SCHEME } from "./identity.js";
import type { Chain, AppSource } from "@prisma/client";

export async function resolveAccountIdFromWallet(
  chain: Chain,
  address: string,
): Promise<string | null> {
  const normalized = normalizeAddress(chain, address);
  const identity = await prisma.identity.findUnique({
    where: { chain_address: { chain, address: normalized } },
    select: { accountId: true },
  });
  return identity?.accountId ?? null;
}

export async function isWalletLinkedToAccount(
  accountId: string,
  chain: Chain,
  address: string,
): Promise<boolean> {
  const normalized = normalizeAddress(chain, address);
  const identity = await prisma.identity.findUnique({
    where: { chain_address: { chain, address: normalized } },
    select: { accountId: true, scheme: true },
  });
  return identity?.scheme === IDENTITY_SCHEME.WALLET && identity.accountId === accountId;
}

export function generateAccountPublicId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "acc_";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (const b of bytes) out += alphabet[b % 32];
  return out;
}

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

export class AccountRequiresEmailError extends Error {
  constructor() {
    super(
      "This app requires a wallet to be linked to an already-registered account. " +
      "No valid accountToken was provided, so a new account cannot be created for it directly.",
    );
    this.name = "AccountRequiresEmailError";
  }
}

// Pure so it's unit-testable without a DB: the only inputs that decide
// whether a brand-new, unlinked account is allowed are these two.
export function shouldRejectNewAccountForWallet(params: {
  linkToAccountId?: string;
  requireExistingAccountLink?: boolean;
}): boolean {
  return Boolean(params.requireExistingAccountLink) && !params.linkToAccountId;
}

export async function ensureAccountForWallet(params: {
  chain: Chain;
  address: string;
  provider?: string;
  appSource: AppSource;
  email?: string;

  linkToAccountId?: string;

  requireExistingAccountLink?: boolean;
}): Promise<{ accountId: string; created: boolean }> {
  const address = normalizeAddress(params.chain, params.address);
  const provider = (params.provider ?? "unknown").toLowerCase();

  const existing = await prisma.identity.findUnique({
    where: { chain_address: { chain: params.chain, address } },
    select: { id: true, accountId: true, provider: true },
  });

  if (existing) {
    if ((existing.provider === null || existing.provider === "unknown") && provider !== "unknown") {
      await prisma.identity.update({ where: { id: existing.id }, data: { provider } });
    }
    return { accountId: existing.accountId, created: false };
  }

  if (params.linkToAccountId) {
    await prisma.identity.create({
      data: {
        accountId: params.linkToAccountId,
        scheme: IDENTITY_SCHEME.WALLET,
        provider,
        chain: params.chain,
        address,
        appSource: params.appSource,
        isPrimary: true,
        email: params.email ?? null,
      },
    });
    return { accountId: params.linkToAccountId, created: false };
  }

  if (shouldRejectNewAccountForWallet(params)) {
    throw new AccountRequiresEmailError();
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

    await tx.identity.create({
      data: {
        accountId: account.id,
        scheme: IDENTITY_SCHEME.WALLET,
        provider,
        chain: params.chain,
        address,
        appSource: params.appSource,
        isPrimary: true,
        email: params.email ?? null,
      },
    });

    await tx.accountProfile.create({ data: { accountId: account.id } });
    return account.id;
  });

  return { accountId, created: true };
}
