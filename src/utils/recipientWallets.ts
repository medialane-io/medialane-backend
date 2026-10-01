import type { Chain } from "@prisma/client";
import prisma from "../db/client.js";
import { IDENTITY_SCHEME } from "./identity.js";
import { ioClientId } from "./caller.js";
import { accountWallets } from "./account.js";

export interface RecipientWallet {
  email: string;
  walletAddress: string | null;
}

/** The wallet of the io account with each email; `null` for an email with no account or no wallet. */
export async function resolveRecipientWallets(chain: Chain, emails: string[]): Promise<RecipientWallet[]> {
  if (emails.length === 0) return [];
  const identities = await prisma.identity.findMany({
    where: { clientId: ioClientId(), scheme: IDENTITY_SCHEME.EMAIL, value: { in: emails } },
    select: { value: true, accountId: true },
  });
  const accountByEmail = new Map(identities.map((i) => [i.value!, i.accountId]));
  const wallets = await accountWallets([...new Set(accountByEmail.values())], chain);
  return emails.map((email) => {
    const accountId = accountByEmail.get(email);
    return { email, walletAddress: accountId ? (wallets.get(accountId) ?? null) : null };
  });
}
