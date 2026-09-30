import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { typedData as starknetTypedData } from "starknet";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { IDENTITY_SCHEME, normalizeIdentityValue } from "../../utils/identity.js";
import { signWithPrivateKey } from "@medialane/sdk/starknet";
import { buildDeployment as buildSponsoredDeployment, defaultClient, executeSponsoredDeploy } from "./paymaster.js";
import { ensureAccountForIdentity, ensureAccountForWallet } from "../../utils/account.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { provisioningKey, type ProvisioningKey, type ProvisioningKeyInput } from "../../utils/provisioningKey.js";
import crypto from "crypto";
import type { Chain, ProvisioningStatus } from "@prisma/client";
import { bill } from "../../payments/usage.js";

export interface ProvisioningRecord {
  id: string;
  apiClientId: string;
  chain: Chain;
  walletAddress: string;
  recipientScheme: string;
  recipientValue: string;
  interimOwnerPubkey: string | null;
  newOwnerPubkey: string | null;
  status: ProvisioningStatus;
}

export interface BusinessProvisioningDeps {
  keyFor: (input: ProvisioningKeyInput) => ProvisioningKey;
  newSalt: () => string;
  buildDeployment: (owner: { ownerPubkey: string; ownerAddress: string }) => Promise<{ typedData: unknown; deployment: unknown }>;
  signTypedData: (privateKey: string, typedData: unknown, address: string) => string[];
  deployWallet: (input: { ownerAddress: string; typedData: unknown; signature: string[]; deployment: unknown }) => Promise<string>;
  ensureRecipientAccount: (clientId: string, recipientScheme: string, recipientValue: string) => Promise<string | null>;
  findExistingWalletForRecipient: (
    chain: Chain,
    recipientScheme: string,
    recipientValue: string,
  ) => Promise<{ accountId: string; walletAddress: string } | null>;
  linkWalletToAccount: (input: { clientId: string; chain: Chain; walletAddress: string; accountId: string }) => Promise<void>;
  createProvisioning: (input: {
    apiClientId: string; accountId: string; chain: Chain; walletAddress: string; recipientScheme: string; recipientValue: string; interimOwnerPubkey: string | null; derivationSalt: string | null; status?: ProvisioningStatus;
  }) => Promise<ProvisioningRecord>;
  listProvisioning: (apiClientId: string, status?: ProvisioningStatus) => Promise<ProvisioningRecord[]>;
  getProvisioningById: (id: string, apiClientId: string) => Promise<ProvisioningRecord | null>;
}

const registerSchema = z.object({
  chain: z.enum(["STARKNET"]).default("STARKNET"),
  recipientScheme: z.string().min(1),
  recipientValue: z.string().min(1),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export type RegisterResult =
  | { status: 200 | 201; record: ProvisioningRecord; reused: boolean }
  | { status: 502; message: string };

/** Gives a recipient a wallet: reuses the one they already have, or deploys a fresh one owned by a key the backend computes. */
export async function registerProvisioning(
  deps: BusinessProvisioningDeps,
  apiClient: { id: string; accountId: string },
  input: RegisterInput,
): Promise<RegisterResult> {
  const { chain, recipientScheme } = input;
  const recipientValue = normalizeIdentityValue(recipientScheme, input.recipientValue);

  const existing = await deps.findExistingWalletForRecipient(chain, recipientScheme, recipientValue);
  if (existing) {
    const record = await deps.createProvisioning({
      apiClientId: apiClient.id,
      accountId: apiClient.accountId,
      chain,
      walletAddress: existing.walletAddress,
      recipientScheme,
      recipientValue,
      interimOwnerPubkey: null,
      derivationSalt: null,
      status: "REUSED",
    });
    return { status: 200, record, reused: true };
  }

  const recipientAccountId = await deps.ensureRecipientAccount(apiClient.id, recipientScheme, recipientValue);
  const salt = deps.newSalt();
  const key = deps.keyFor({ apiClientId: apiClient.id, recipientScheme, recipientValue, salt });
  const walletAddress = normalizeAddress(chain, key.walletAddress);

  try {
    const built = await deps.buildDeployment({ ownerPubkey: key.publicKey, ownerAddress: walletAddress });
    await deps.deployWallet({
      ownerAddress: walletAddress,
      typedData: built.typedData,
      signature: deps.signTypedData(key.privateKey, built.typedData, walletAddress),
      deployment: built.deployment,
    });
  } catch (err) {
    return { status: 502, message: err instanceof Error ? err.message : "deploy_failed" };
  }

  if (recipientAccountId) {
    await deps.linkWalletToAccount({ clientId: apiClient.id, chain, walletAddress, accountId: recipientAccountId });
  }

  const record = await deps.createProvisioning({
    apiClientId: apiClient.id,
    accountId: apiClient.accountId,
    chain,
    walletAddress,
    recipientScheme,
    recipientValue,
    interimOwnerPubkey: normalizeAddress(chain, key.publicKey),
    derivationSalt: salt,
  });
  return { status: 201, record, reused: false };
}

export function createBusinessProvisioningRoutes(deps: BusinessProvisioningDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", zValidator("json", registerSchema), async (c) => {
    const result = await registerProvisioning(deps, c.get("apiClient"), c.req.valid("json"));
    if (result.status === 502) return c.json({ error: "deploy_failed", message: result.message }, 502);
    if (result.reused) {
      bill(c, 0);
      return c.json({ data: result.record, reusedExistingWallet: true }, 200);
    }
    return c.json({ data: result.record }, 201);
  });

  app.get("/", async (c) => {
    const apiClient = c.get("apiClient");
    const status = c.req.query("status") as ProvisioningStatus | undefined;
    const rows = await deps.listProvisioning(apiClient.id, status);
    return c.json({ data: rows });
  });

  return app;
}

function assertLinked<T extends { apiClientId: string | null }>(row: T): T & { apiClientId: string } {
  if (row.apiClientId === null) {
    throw new Error(`BusinessProvisioning ${(row as { id?: string }).id ?? "?"} has no apiClientId — backfill gap`);
  }
  return row as T & { apiClientId: string };
}

export const productionProvisioningDeps: BusinessProvisioningDeps = {
  keyFor: provisioningKey,
  newSalt: () => crypto.randomBytes(16).toString("hex"),
  buildDeployment: async (owner) => {
    const outcome = await buildSponsoredDeployment({ clientFactory: defaultClient }, owner);
    if (outcome.status !== 200) throw new Error(outcome.body.error);
    return { typedData: outcome.body.typedData, deployment: outcome.body.deployment };
  },
  signTypedData: (privateKey, typedData, address) =>
    signWithPrivateKey(privateKey, starknetTypedData.getMessageHash(typedData as never, address)),
  deployWallet: (input) => executeSponsoredDeploy(input),

  createProvisioning: async (input) => assertLinked(await prisma.businessProvisioning.create({ data: input })),
  listProvisioning: async (apiClientId, status) =>
    (await prisma.businessProvisioning.findMany({ where: { apiClientId, ...(status ? { status } : {}) } })).map(assertLinked),
  getProvisioningById: async (id, apiClientId) => {
    const row = await prisma.businessProvisioning.findUnique({ where: { id } });
    return row && row.apiClientId === apiClientId ? assertLinked(row) : null;
  },
  findExistingWalletForRecipient: async (chain, recipientScheme, recipientValue) => {
    const identities = await prisma.identity.findMany({
      where: {
        scheme: recipientScheme,
        value: normalizeIdentityValue(recipientScheme, recipientValue),
      },
      select: { accountId: true },
    });
    if (identities.length === 0) return null;

    const accountIds = [...new Set(identities.map((i) => i.accountId))];
    const wallet = await prisma.identity.findFirst({
      where: { accountId: { in: accountIds }, chain, scheme: IDENTITY_SCHEME.WALLET, address: { not: null } },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { accountId: true, address: true },
    });
    if (!wallet?.address) return null;
    return { accountId: wallet.accountId, walletAddress: wallet.address };
  },
  ensureRecipientAccount: async (clientId, recipientScheme, recipientValue) => {
    const { accountId } = await ensureAccountForIdentity(recipientScheme, recipientValue, clientId);
    return accountId;
  },
  linkWalletToAccount: async ({ clientId, chain, walletAddress, accountId }) => {
    await ensureAccountForWallet({
      chain,
      address: walletAddress,
      provider: "mediawallet",
      clientId,
      linkToAccountId: accountId,
    });
  },
};

export const businessProvisioningRoutes = createBusinessProvisioningRoutes(productionProvisioningDeps);
