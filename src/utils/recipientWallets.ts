import type { Chain } from "@prisma/client";
import prisma from "../db/client.js";
import { IDENTITY_SCHEME } from "./identity.js";

export interface RecipientWallet {
  recipientValue: string;
  walletAddress: string | null;
}

export async function resolveRecipientWallets(chain: Chain, scheme: string, values: string[]): Promise<RecipientWallet[]> {
  if (values.length === 0) return [];
  const identities = await prisma.identity.findMany({
    where: { scheme, value: { in: values } },
    select: { value: true, accountId: true },
  });
  const accountByValue = new Map(identities.map((i) => [i.value!, i.accountId]));

  const accountIds = [...new Set(accountByValue.values())];
  const wallets = await prisma.identity.findMany({
    where: { accountId: { in: accountIds }, chain, scheme: IDENTITY_SCHEME.WALLET, address: { not: null } },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { accountId: true, address: true },
  });
  const walletByAccount = new Map<string, string>();
  for (const w of wallets) {
    if (!walletByAccount.has(w.accountId)) walletByAccount.set(w.accountId, w.address!);
  }

  return values.map((value) => {
    const accountId = accountByValue.get(value);
    return {
      recipientValue: value,
      walletAddress: accountId ? (walletByAccount.get(accountId) ?? null) : null,
    };
  });
}
