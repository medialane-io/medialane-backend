import type { Call } from "starknet";
import { typedData as starknetTypedData } from "starknet";
import { buildAddOwnerCall, computeOwnerGuid, getOwners, signWithPrivateKey } from "@medialane/sdk/starknet";
import prisma from "../db/client.js";
import { accountWallet } from "../utils/account.js";
import { recordAccountEvent } from "../utils/accountEvents.js";
import { createProvider } from "../utils/starknet.js";
import { provisioningKey, type ProvisioningKey } from "../utils/provisioningKey.js";
import { executeOwnSponsoredInvoke } from "../api/routes/paymaster.js";

export interface WalletKeyDeps {
  walletOf(accountId: string): Promise<string | null>;
  ownerGuidsOf(walletAddress: string): Promise<string[]>;
  keyFor(accountId: string): ProvisioningKey;
  execute(input: { walletAddress: string; calls: Call[]; privateKey: string }): Promise<string>;
  waitFor(txHash: string): Promise<void>;
  recordKeyAdded(accountId: string, wallet: string, txHash: string): Promise<void>;
}

export type WalletKeyOutcome =
  | { status: 200; walletAddress: string; removeOwnerGuid: string | null }
  | { status: 403 | 404 | 409 | 502; error: string };

const sameFelt = (a: string, b: string) => BigInt(a) === BigInt(b);

const ownsWallet = (owners: string[], pubkey: string) => owners.some((g) => sameFelt(g, computeOwnerGuid(pubkey)));

export async function needsKeySetup(
  deps: Pick<WalletKeyDeps, "ownerGuidsOf" | "keyFor">,
  accountId: string,
  walletAddress: string,
): Promise<boolean> {
  let key: ProvisioningKey;
  try {
    key = deps.keyFor(accountId);
  } catch {
    return false;
  }
  return ownsWallet(await deps.ownerGuidsOf(walletAddress), key.publicKey);
}

export async function setupWalletKey(
  deps: WalletKeyDeps,
  accountId: string,
  newOwnerPubkey: string,
): Promise<WalletKeyOutcome> {
  const walletAddress = await deps.walletOf(accountId);
  if (!walletAddress) return { status: 404, error: "This account has no wallet" };

  const key = deps.keyFor(accountId);
  const removeOwnerGuid = computeOwnerGuid(key.publicKey);
  const owners = await deps.ownerGuidsOf(walletAddress);

  if (!ownsWallet(owners, key.publicKey)) {
    return ownsWallet(owners, newOwnerPubkey)
      ? { status: 200, walletAddress, removeOwnerGuid: null }
      : { status: 409, error: "This wallet is already set up with its owner's keys" };
  }
  if (ownsWallet(owners, newOwnerPubkey)) return { status: 200, walletAddress, removeOwnerGuid };

  let txHash: string;
  try {
    txHash = await deps.execute({
      walletAddress,
      calls: [buildAddOwnerCall(walletAddress, newOwnerPubkey)],
      privateKey: key.privateKey,
    });
    await deps.waitFor(txHash);
  } catch (err) {
    return { status: 502, error: err instanceof Error ? err.message : "The wallet key could not be set up" };
  }

  if (!ownsWallet(await deps.ownerGuidsOf(walletAddress), newOwnerPubkey)) {
    return { status: 502, error: "The wallet key could not be set up" };
  }
  await deps.recordKeyAdded(accountId, walletAddress, txHash);
  return { status: 200, walletAddress, removeOwnerGuid };
}

export const productionWalletKeyDeps: WalletKeyDeps = {
  walletOf: (accountId) => accountWallet(accountId),
  ownerGuidsOf: async (walletAddress) => (await getOwners(createProvider(), walletAddress)).map((o) => o.guid),
  keyFor: provisioningKey,
  execute: ({ walletAddress, calls, privateKey }) =>
    executeOwnSponsoredInvoke({
      userAddress: walletAddress,
      calls,
      sign: (typedData) => signWithPrivateKey(privateKey, starknetTypedData.getMessageHash(typedData as never, walletAddress)),
    }),
  waitFor: async (txHash) => {
    await createProvider().waitForTransaction(txHash);
  },
  recordKeyAdded: (accountId, wallet, txHash) =>
    recordAccountEvent(prisma, accountId, "WALLET_KEY_ADDED", { wallet, txHash }),
};
