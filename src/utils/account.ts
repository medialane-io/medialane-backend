import prisma from "../db/client.js";
import { normalizeAddress } from "./starknet.js";
import { IDENTITY_SCHEME, normalizeIdentityValue } from "./identity.js";
import type { Chain } from "@prisma/client";

export async function ensureApiCredits(accountId: string) {
  return prisma.apiCredits.upsert({
    where: { accountId },
    create: { accountId },
    update: {},
    select: { id: true, accountId: true, creditBalance: true },
  });
}

const WALLET_ORDER = [{ createdAt: "asc" as const }];

export async function accountWallet(accountId: string, chain: Chain = "STARKNET"): Promise<string | null> {
  const wallet = await prisma.identity.findFirst({
    where: { accountId, chain, scheme: IDENTITY_SCHEME.WALLET, address: { not: null } },
    orderBy: WALLET_ORDER,
    select: { address: true },
  });
  return wallet?.address ?? null;
}

export async function accountWallets(accountIds: string[], chain: Chain = "STARKNET"): Promise<Map<string, string>> {
  const wallets = await prisma.identity.findMany({
    where: { accountId: { in: accountIds }, chain, scheme: IDENTITY_SCHEME.WALLET, address: { not: null } },
    orderBy: WALLET_ORDER,
    select: { accountId: true, address: true },
  });
  const byAccount = new Map<string, string>();
  for (const w of wallets) {
    if (!byAccount.has(w.accountId)) byAccount.set(w.accountId, w.address!);
  }
  return byAccount;
}

export async function resolveAccountIdFromWallet(
  appId: string,
  chain: Chain,
  address: string,
): Promise<string | null> {
  const normalized = normalizeAddress(chain, address);
  const identity = await prisma.identity.findUnique({
    where: { appId_chain_address: { appId, chain, address: normalized } },
    select: { accountId: true },
  });
  return identity?.accountId ?? null;
}

export async function accountIdsHoldingWallet(chain: Chain, address: string): Promise<string[]> {
  const normalized = normalizeAddress(chain, address);
  const rows = await prisma.identity.findMany({
    where: { chain, address: normalized, scheme: IDENTITY_SCHEME.WALLET },
    select: { accountId: true },
  });
  return [...new Set(rows.map((row) => row.accountId))];
}

export async function isWalletLinkedToAccount(
  accountId: string,
  chain: Chain,
  address: string,
): Promise<boolean> {
  const normalized = normalizeAddress(chain, address);
  const identity = await prisma.identity.findFirst({
    where: { accountId, chain, address: normalized, scheme: IDENTITY_SCHEME.WALLET },
    select: { id: true },
  });
  return identity !== null;
}

export function generateAccountPublicId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "acc_";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (const b of bytes) out += alphabet[b % 32];
  return out;
}

export class WalletAlreadyAttachedError extends Error {
  constructor() {
    super("This account already has a wallet");
    this.name = "WalletAlreadyAttachedError";
  }
}

export async function replaceWallet(params: {
  accountId: string;
  appId: string;
  chain: Chain;
  address: string;
}): Promise<void> {
  const address = normalizeAddress(params.chain, params.address);
  await prisma.$transaction(async (tx) => {
    await tx.identity.deleteMany({ where: { accountId: params.accountId, scheme: IDENTITY_SCHEME.WALLET } });
    await tx.identity.create({
      data: {
        accountId: params.accountId,
        scheme: IDENTITY_SCHEME.WALLET,
        provider: "unknown",
        chain: params.chain,
        address,
        appId: params.appId,
      },
    });
  });
}

export async function ensureAccountForWallet(params: {
  chain: Chain;
  address: string;
  provider?: string;
  appId: string;
  linkToAccountId?: string;
}): Promise<{ accountId: string; created: boolean }> {
  const address = normalizeAddress(params.chain, params.address);
  const provider = (params.provider ?? "unknown").toLowerCase();

  const existing = await prisma.identity.findUnique({
    where: { appId_chain_address: { appId: params.appId, chain: params.chain, address } },
    select: { id: true, accountId: true, provider: true },
  });

  if (existing) {
    if ((existing.provider === null || existing.provider === "unknown") && provider !== "unknown") {
      await prisma.identity.update({ where: { id: existing.id }, data: { provider } });
    }
    return { accountId: existing.accountId, created: false };
  }

  if (params.linkToAccountId) {
    const held = await prisma.identity.findFirst({
      where: { accountId: params.linkToAccountId, scheme: IDENTITY_SCHEME.WALLET },
      select: { id: true },
    });
    if (held) throw new WalletAlreadyAttachedError();
    await prisma.identity.create({
      data: {
        accountId: params.linkToAccountId,
        scheme: IDENTITY_SCHEME.WALLET,
        provider,
        chain: params.chain,
        address,
        appId: params.appId,
      },
    });
    return { accountId: params.linkToAccountId, created: false };
  }

  const accountId = await prisma.$transaction(async (tx) => {
    let account: { id: string } | null = null;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        account = await tx.account.create({
          data: { publicId: generateAccountPublicId() },
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
        appId: params.appId,
      },
    });

    await tx.accountProfile.create({ data: { accountId: account.id } });
    return account.id;
  });

  return { accountId, created: true };
}

export async function ensureAccountForIdentity(
  scheme: string,
  rawValue: string,
  appId: string,
): Promise<{ accountId: string; created: boolean }> {
  const value = normalizeIdentityValue(scheme, rawValue);
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await prisma.identity.findUnique({
      where: { appId_scheme_value: { appId, scheme, value } },
      select: { accountId: true },
    });
    if (existing) return { accountId: existing.accountId, created: false };

    try {
      const accountId = await prisma.$transaction(async (tx) => {
        const account = await tx.account.create({
          data: { publicId: generateAccountPublicId() },
          select: { id: true },
        });
        await tx.identity.create({
          data: {
            accountId: account.id,
            scheme,
            value,
            appId,
          },
        });
        return account.id;
      });
      return { accountId, created: true };
    } catch (err) {
      const isUniqueViolation =
        typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002";
      if (!isUniqueViolation) throw err;
    }
  }
  throw new Error("Failed to create account after 3 attempts");
}
