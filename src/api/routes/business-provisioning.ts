import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { typedData as starknetTypedData } from "starknet";
import type { Chain } from "@prisma/client";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { IDENTITY_SCHEME, normalizeIdentityValue } from "../../utils/identity.js";
import { signWithPrivateKey } from "@medialane/sdk/starknet";
import { buildDeployment as buildSponsoredDeployment, defaultClient, executeSponsoredDeploy } from "./paymaster.js";
import { accountWallet, ensureAccountForIdentity, ensureAccountForWallet } from "../../utils/account.js";
import { createProvider, isContractNotFound, normalizeAddress } from "../../utils/starknet.js";
import { ioApiCreditsId } from "../../utils/caller.js";
import { provisioningKey, type ProvisioningKey } from "../../utils/provisioningKey.js";
import { bill } from "../../payments/usage.js";

export interface BusinessProvisioningDeps {
  findIoAccount: (email: string) => Promise<{ accountId: string; walletAddress: string | null } | null>;
  createIoAccount: (email: string) => Promise<string>;
  keyFor: (accountId: string) => ProvisioningKey;
  isDeployed: (walletAddress: string) => Promise<boolean>;
  buildDeployment: (owner: { ownerPubkey: string; ownerAddress: string }) => Promise<{ typedData: unknown; deployment: unknown }>;
  signTypedData: (privateKey: string, typedData: unknown, address: string) => string[];
  deployWallet: (input: { ownerAddress: string; typedData: unknown; signature: string[]; deployment: unknown }) => Promise<string>;
  linkWallet: (input: { chain: Chain; walletAddress: string; accountId: string }) => Promise<void>;
}

const registerSchema = z.object({
  chain: z.enum(["STARKNET"]).default("STARKNET"),
  email: z.string().email(),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export type RegisterResult =
  | { status: 200 | 201; walletAddress: string; reused: boolean }
  | { status: 502; message: string };

export async function registerProvisioning(deps: BusinessProvisioningDeps, input: RegisterInput): Promise<RegisterResult> {
  const { chain } = input;
  const email = normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, input.email);

  const account = await deps.findIoAccount(email);
  if (account?.walletAddress) {
    return { status: 200, walletAddress: normalizeAddress(chain, account.walletAddress), reused: true };
  }

  const accountId = account?.accountId ?? (await deps.createIoAccount(email));
  const key = deps.keyFor(accountId);
  const walletAddress = normalizeAddress(chain, key.walletAddress);

  try {
    if (!(await deps.isDeployed(walletAddress))) {
      const built = await deps.buildDeployment({ ownerPubkey: key.publicKey, ownerAddress: walletAddress });
      await deps.deployWallet({
        ownerAddress: walletAddress,
        typedData: built.typedData,
        signature: deps.signTypedData(key.privateKey, built.typedData, walletAddress),
        deployment: built.deployment,
      });
    }
  } catch (err) {
    return { status: 502, message: err instanceof Error ? err.message : "deploy_failed" };
  }

  await deps.linkWallet({ chain, walletAddress, accountId });
  return { status: 201, walletAddress, reused: false };
}

export function createBusinessProvisioningRoutes(deps: BusinessProvisioningDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", zValidator("json", registerSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await registerProvisioning(deps, input);
    if (result.status === 502) return c.json({ error: "deploy_failed", message: result.message }, 502);
    const data = { chain: input.chain, walletAddress: result.walletAddress };
    if (result.reused) {
      bill(c, 0);
      return c.json({ data, reusedExistingWallet: true }, 200);
    }
    return c.json({ data }, 201);
  });

  return app;
}

export const productionProvisioningDeps: BusinessProvisioningDeps = {
  findIoAccount: async (email) => {
    const identity = await prisma.identity.findUnique({
      where: { apiCreditsId_scheme_value: { apiCreditsId: ioApiCreditsId(), scheme: IDENTITY_SCHEME.EMAIL, value: email } },
      select: { accountId: true },
    });
    if (!identity) return null;
    return { accountId: identity.accountId, walletAddress: await accountWallet(identity.accountId) };
  },
  createIoAccount: async (email) => (await ensureAccountForIdentity(IDENTITY_SCHEME.EMAIL, email, ioApiCreditsId())).accountId,
  keyFor: provisioningKey,
  isDeployed: async (walletAddress) => {
    try {
      await createProvider().getClassHashAt(walletAddress);
      return true;
    } catch (err) {
      if (isContractNotFound(err)) return false;
      throw err;
    }
  },
  buildDeployment: async (owner) => {
    const outcome = await buildSponsoredDeployment({ clientFactory: defaultClient }, owner);
    if (outcome.status !== 200) throw new Error(outcome.body.error);
    return { typedData: outcome.body.typedData, deployment: outcome.body.deployment };
  },
  signTypedData: (privateKey, typedData, address) =>
    signWithPrivateKey(privateKey, starknetTypedData.getMessageHash(typedData as never, address)),
  deployWallet: (input) => executeSponsoredDeploy(input),
  linkWallet: async ({ chain, walletAddress, accountId }) => {
    await ensureAccountForWallet({ chain, address: walletAddress, provider: "mediawallet", apiCreditsId: ioApiCreditsId(), linkToAccountId: accountId });
  },
};

export const businessProvisioningRoutes = createBusinessProvisioningRoutes(productionProvisioningDeps);
