import { z } from "zod";
import { apiKeyConfirmationTypedData, type ApiKeyAction } from "@medialane/sdk/starknet";
import prisma from "../db/client.js";
import { verifyWalletSignature } from "../auth/verify.js";
import { accountWallet } from "../utils/account.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("portal:apiKeyConfirmation");

export const CONFIRMATION_MAX_SECONDS = 5 * 60;

const confirmationSchema = z.object({
  expiresAt: z.number().int(),
  signature: z.array(z.string().min(1)).min(1),
});

export interface KeyConfirmationDeps {
  account(accountId: string): Promise<{ publicId: string; wallet: string | null } | null>;
  verify(input: { address: string; typedData: unknown; signature: string[] }): Promise<boolean>;
  now?: () => number;
}

/** True when `confirmation` is the account's wallet signature over exactly this change, and not expired. */
export async function confirmKeyChange(
  deps: KeyConfirmationDeps,
  accountId: string,
  change: { action: ApiKeyAction; key: string },
  confirmation: unknown,
): Promise<boolean> {
  const parsed = confirmationSchema.safeParse(confirmation);
  if (!parsed.success) return false;
  const { expiresAt, signature } = parsed.data;
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  if (expiresAt < now || expiresAt > now + CONFIRMATION_MAX_SECONDS) return false;

  const account = await deps.account(accountId);
  if (!account?.wallet) return false;
  const typedData = apiKeyConfirmationTypedData({ ...change, account: account.publicId, expiresAt });
  try {
    return await deps.verify({ address: account.wallet, typedData, signature });
  } catch (err) {
    log.warn({ err, accountId }, "API key confirmation could not be verified");
    return false;
  }
}

export const productionKeyConfirmationDeps: KeyConfirmationDeps = {
  account: async (accountId) => {
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: { publicId: true } });
    return account ? { publicId: account.publicId, wallet: await accountWallet(accountId) } : null;
  },
  verify: async ({ address, typedData, signature }) =>
    (await verifyWalletSignature({ chain: "STARKNET", address, typedData, signature })).ok,
};
