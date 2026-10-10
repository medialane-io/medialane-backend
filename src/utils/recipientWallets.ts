import type { Chain } from "@prisma/client";
import prisma from "../db/client.js";
import { IO_APP } from "./caller.js";
import { accountWallets, liveEmailWhere } from "./account.js";

export interface RecipientWallet {
  email: string;
  walletAddress: string | null;
}

export async function resolveRecipientWallets(chain: Chain, emails: string[]): Promise<RecipientWallet[]> {
  if (emails.length === 0) return [];
  const identities = await prisma.identity.findMany({
    where: liveEmailWhere(IO_APP, emails),
    select: { value: true, accountId: true },
  });
  const accountByEmail = new Map(identities.map((i) => [i.value!, i.accountId]));
  const wallets = await accountWallets([...new Set(accountByEmail.values())], chain);
  return emails.map((email) => {
    const accountId = accountByEmail.get(email);
    return { email, walletAddress: accountId ? (wallets.get(accountId) ?? null) : null };
  });
}
