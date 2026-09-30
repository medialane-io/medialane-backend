import type { Call } from "starknet";
import { typedData as starknetTypedData } from "starknet";
import type { Chain } from "@prisma/client";
import { buildChangeOwnersCall, signWithPrivateKey } from "@medialane/sdk/starknet";
import prisma from "../db/client.js";
import { IDENTITY_SCHEME, normalizeIdentityValue } from "../utils/identity.js";
import { ensureAccountForWallet } from "../utils/account.js";
import { provisioningKey, type ProvisioningKey, type ProvisioningKeyInput } from "../utils/provisioningKey.js";
import { buildSponsoredInvoke, defaultClient, executeSponsoredInvoke } from "../api/routes/paymaster.js";
import { createContractAddressChecker } from "../api/routes/paymaster-contract-address.js";

export interface ClaimProof {
  walletAddress: string;
  signature: string[];
  expiration: number;
}

export interface WaitingRow {
  id: string;
  apiClientId: string;
  chain: Chain;
  walletAddress: string;
  recipientScheme: string;
  recipientValue: string;
  interimOwnerPubkey: string;
  derivationSalt: string;
}

export interface ClaimDeps {
  verifiedEmailOf(accountId: string): Promise<string | null>;
  waitingFor(email: string): Promise<WaitingRow[]>;
  keyFor(input: ProvisioningKeyInput): ProvisioningKey;
  buildInvoke(userAddress: string, calls: Call[]): Promise<unknown>;
  executeInvoke(userAddress: string, typedData: unknown, signature: string[], calls: Call[]): Promise<string>;
  signTypedData(privateKey: string, typedData: unknown, address: string): string[];
  linkWallet(input: { chain: Chain; walletAddress: string; accountId: string }): Promise<void>;
  markTransferred(id: string, newOwnerPubkey: string): Promise<void>;
}

export type ClaimOutcome = { status: 200; claimed: string[] } | { status: 403 | 404 | 502; error: string };

const sameFelt = (a: string, b: string) => BigInt(a) === BigInt(b);

export async function claimWallets(
  deps: ClaimDeps,
  accountId: string,
  newOwnerPubkey: string,
  proofs: ClaimProof[],
): Promise<ClaimOutcome> {
  const email = await deps.verifiedEmailOf(accountId);
  if (!email) return { status: 403, error: "Verify your email first" };

  const rows = await deps.waitingFor(normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email));
  const claimed: string[] = [];

  for (const proof of proofs) {
    const row = rows.find((r) => sameFelt(r.walletAddress, proof.walletAddress));
    if (!row) return { status: 404, error: "No wallet is waiting for your email at that address" };

    const key = deps.keyFor({
      apiClientId: row.apiClientId,
      recipientScheme: row.recipientScheme,
      recipientValue: row.recipientValue,
      salt: row.derivationSalt,
    });
    if (!sameFelt(key.publicKey, row.interimOwnerPubkey)) continue;

    const calls = [
      buildChangeOwnersCall(row.walletAddress, key.publicKey, newOwnerPubkey, {
        newOwnerPubkey,
        signature: proof.signature,
        expiration: proof.expiration,
      }),
    ];

    try {
      const typedData = await deps.buildInvoke(row.walletAddress, calls);
      await deps.executeInvoke(row.walletAddress, typedData, deps.signTypedData(key.privateKey, typedData, row.walletAddress), calls);
    } catch (err) {
      return { status: 502, error: err instanceof Error ? err.message : "The wallet could not be handed over" };
    }

    await deps.linkWallet({ chain: row.chain, walletAddress: row.walletAddress, accountId });
    await deps.markTransferred(row.id, newOwnerPubkey);
    claimed.push(row.walletAddress);
  }

  return { status: 200, claimed };
}

export function productionClaimDeps(tenantId: string): ClaimDeps {
  const sponsor = { clientFactory: defaultClient, addressChecker: createContractAddressChecker(prisma) };
  return {
    verifiedEmailOf: async (accountId) =>
      (
        await prisma.identity.findFirst({
          where: { accountId, scheme: IDENTITY_SCHEME.EMAIL, verifiedAt: { not: null } },
          select: { value: true },
        })
      )?.value ?? null,
    waitingFor: async (email) =>
      (await prisma.businessProvisioning.findMany({
        where: {
          recipientScheme: IDENTITY_SCHEME.EMAIL,
          recipientValue: email,
          status: "DEPLOYED",
          interimOwnerPubkey: { not: null },
          derivationSalt: { not: null },
        },
      })) as WaitingRow[],
    keyFor: provisioningKey,
    buildInvoke: async (userAddress, calls) => {
      const outcome = await buildSponsoredInvoke(sponsor, { userAddress, calls });
      if (outcome.status !== 200) throw new Error(String(outcome.body.error));
      return outcome.body.typedData;
    },
    executeInvoke: async (userAddress, typedData, signature, calls) => {
      const outcome = await executeSponsoredInvoke(sponsor, { userAddress, typedData, signature, calls });
      if (outcome.status !== 200) throw new Error(String(outcome.body.error));
      return String(outcome.body.transactionHash);
    },
    signTypedData: (privateKey, typedData, address) =>
      signWithPrivateKey(privateKey, starknetTypedData.getMessageHash(typedData as never, address)),
    linkWallet: async ({ chain, walletAddress, accountId }) => {
      const existing = await prisma.identity.findUnique({
        where: { chain_address: { chain, address: walletAddress } },
        select: { id: true },
      });
      if (existing) {
        await prisma.identity.update({ where: { id: existing.id }, data: { accountId } });
        return;
      }
      await ensureAccountForWallet({ chain, address: walletAddress, provider: "mediawallet", tenantId, linkToAccountId: accountId });
    },
    markTransferred: async (id, newOwnerPubkey) => {
      await prisma.businessProvisioning.update({ where: { id }, data: { status: "TRANSFERRED", newOwnerPubkey } });
    },
  };
}
