import type { Call } from "starknet";
import { typedData as starknetTypedData } from "starknet";
import { buildChangeOwnersCall, computeOwnerGuid, getOwners, signWithPrivateKey } from "@medialane/sdk/starknet";
import prisma from "../db/client.js";
import { IDENTITY_SCHEME } from "../utils/identity.js";
import { createProvider } from "../utils/starknet.js";
import { provisioningKey, type ProvisioningKey } from "../utils/provisioningKey.js";
import { executeOwnSponsoredInvoke } from "../api/routes/paymaster.js";

export interface OwnerAliveProof {
  signature: string[];
  expiration: number;
}

export interface WalletKeyDeps {
  emailVerified(accountId: string): Promise<boolean>;
  walletOf(accountId: string): Promise<string | null>;
  /** The wallet's owner guids, read on-chain. */
  ownerGuidsOf(walletAddress: string): Promise<string[]>;
  keyFor(accountId: string): ProvisioningKey;
  execute(input: { walletAddress: string; calls: Call[]; privateKey: string }): Promise<string>;
  waitFor(txHash: string): Promise<void>;
}

export type WalletKeyOutcome =
  | { status: 200; walletAddress: string }
  | { status: 403 | 404 | 409 | 502; error: string };

const sameFelt = (a: string, b: string) => BigInt(a) === BigInt(b);

const ownsWallet = (owners: string[], pubkey: string) => owners.some((g) => sameFelt(g, computeOwnerGuid(pubkey)));

/** Whether the backend key still owns the wallet, read on-chain. */
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

/** Makes the passkey the only owner of the account's wallet. */
export async function setupWalletKey(
  deps: WalletKeyDeps,
  accountId: string,
  newOwnerPubkey: string,
  proof: OwnerAliveProof,
): Promise<WalletKeyOutcome> {
  if (!(await deps.emailVerified(accountId))) return { status: 403, error: "Verify your email first" };

  const walletAddress = await deps.walletOf(accountId);
  if (!walletAddress) return { status: 404, error: "This account has no wallet" };

  const owners = await deps.ownerGuidsOf(walletAddress);
  if (ownsWallet(owners, newOwnerPubkey)) return { status: 200, walletAddress };

  const key = deps.keyFor(accountId);
  if (!ownsWallet(owners, key.publicKey)) {
    return { status: 409, error: "This wallet is already set up with its owner's keys" };
  }

  const calls = [
    buildChangeOwnersCall(walletAddress, key.publicKey, newOwnerPubkey, {
      newOwnerPubkey,
      signature: proof.signature,
      expiration: proof.expiration,
    }),
  ];
  try {
    await deps.waitFor(await deps.execute({ walletAddress, calls, privateKey: key.privateKey }));
  } catch (err) {
    return { status: 502, error: err instanceof Error ? err.message : "The wallet key could not be set up" };
  }

  const after = await deps.ownerGuidsOf(walletAddress);
  if (after.length !== 1 || !ownsWallet(after, newOwnerPubkey)) {
    return { status: 502, error: "The wallet key could not be set up" };
  }
  return { status: 200, walletAddress };
}

export const productionWalletKeyDeps: WalletKeyDeps = {
  emailVerified: async (accountId) =>
    (await prisma.identity.count({ where: { accountId, scheme: IDENTITY_SCHEME.EMAIL, verifiedAt: { not: null } } })) > 0,
  walletOf: async (accountId) =>
    (
      await prisma.identity.findFirst({
        where: { accountId, chain: "STARKNET", scheme: IDENTITY_SCHEME.WALLET, address: { not: null } },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: { address: true },
      })
    )?.address ?? null,
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
};
