import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { computeAccountAddress } from "@medialane/sdk/starknet";
import { executeSponsoredDeploy } from "./paymaster.js";
import { ensureAccountForEmail, ensureAccountForWallet } from "../../utils/account.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { isAccountOwner as realIsAccountOwner } from "../../chainRead/index.js";
import crypto from "crypto";
import type { Chain, ProvisioningStatus } from "@prisma/client";

export interface ProvisioningRecord {
  id: string;
  apiClientId: string;
  chain: Chain;
  walletAddress: string;
  recipientScheme: string;
  recipientValue: string;
  interimOwnerPubkey: string;
  newOwnerPubkey: string | null;
  status: ProvisioningStatus;
}

export interface BusinessProvisioningDeps {
  isAccountOwner: (chain: Chain, walletAddress: string, ownerPubkey: string) => Promise<boolean>;
  deriveWalletAddress: (ownerPubkey: string) => string;
  deployWallet: (input: { ownerAddress: string; typedData: unknown; signature: string[]; deployment: unknown }) => Promise<string>;
  ensureRecipientAccount: (recipientScheme: string, recipientValue: string) => Promise<string | null>;
  linkWalletToAccount: (input: { chain: Chain; walletAddress: string; accountId: string }) => Promise<void>;
  createProvisioning: (input: {
    apiClientId: string; accountId: string; chain: Chain; walletAddress: string; recipientScheme: string; recipientValue: string; interimOwnerPubkey: string;
  }) => Promise<ProvisioningRecord>;
  listProvisioning: (apiClientId: string, status?: ProvisioningStatus) => Promise<ProvisioningRecord[]>;
  getProvisioningById: (id: string, apiClientId: string) => Promise<ProvisioningRecord | null>;
  getProvisioningByIdUnscoped: (id: string) => Promise<ProvisioningRecord | null>;
  markTransferred: (id: string) => Promise<ProvisioningRecord>;
  recordNewOwnerPubkey: (id: string, newOwnerPubkey: string) => Promise<ProvisioningRecord>;
}

const registerSchema = z.object({
  chain: z.enum(["STARKNET"]).default("STARKNET"),
  recipientScheme: z.string().min(1),
  recipientValue: z.string().min(1),
  interimOwnerPubkey: z.string(),
  deployment: z.object({
    typedData: z.unknown(),
    signature: z.array(z.string()).min(1),
    deployment: z.unknown(),
  }),
});

export function createBusinessProvisioningRoutes(deps: BusinessProvisioningDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", zValidator("json", registerSchema), async (c) => {
    const { chain, recipientScheme, recipientValue, interimOwnerPubkey, deployment } = c.req.valid("json");
    const apiClient = c.get("apiClient");
    const normPubkey = normalizeAddress(chain, interimOwnerPubkey);
    const normWallet = normalizeAddress(chain, deps.deriveWalletAddress(normPubkey));

    try {
      await deps.deployWallet({
        ownerAddress: normWallet,
        typedData: deployment.typedData,
        signature: deployment.signature,
        deployment: deployment.deployment,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "deploy_failed";
      return c.json({ error: "deploy_failed", message }, 502);
    }

    const recipientAccountId = await deps.ensureRecipientAccount(recipientScheme, recipientValue);
    if (recipientAccountId) {
      await deps.linkWalletToAccount({ chain, walletAddress: normWallet, accountId: recipientAccountId });
    }

    const record = await deps.createProvisioning({
      apiClientId: apiClient.id, accountId: apiClient.accountId, chain, walletAddress: normWallet, recipientScheme, recipientValue, interimOwnerPubkey: normPubkey,
    });

    return c.json({ data: record }, 201);
  });

  app.get("/", async (c) => {
    const apiClient = c.get("apiClient");
    const status = c.req.query("status") as ProvisioningStatus | undefined;
    const rows = await deps.listProvisioning(apiClient.id, status);
    return c.json({ data: rows });
  });

  app.post("/:id/complete", async (c) => {
    const id = c.req.param("id");
    const apiClient = c.get("apiClient");
    const record = await deps.getProvisioningById(id, apiClient.id);
    if (!record) return c.json({ error: "not_found" }, 404);
    if (!record.newOwnerPubkey) return c.json({ error: "not_claimed_yet" }, 409);

    const [newOwnerConfirmed, interimStillOwner] = await Promise.all([
      deps.isAccountOwner(record.chain, record.walletAddress, record.newOwnerPubkey),
      deps.isAccountOwner(record.chain, record.walletAddress, record.interimOwnerPubkey),
    ]);
    if (!newOwnerConfirmed || interimStillOwner) return c.json({ error: "handoff_not_confirmed_onchain" }, 409);

    const updated = await deps.markTransferred(id);
    return c.json({ data: updated });
  });

  return app;
}

function assertLinked<T extends { apiClientId: string | null }>(row: T): T & { apiClientId: string } {
  if (row.apiClientId === null) {
    throw new Error(`BusinessProvisioning ${(row as { id?: string }).id ?? "?"} has no apiClientId — backfill gap`);
  }
  return row as T & { apiClientId: string };
}

const productionDeps: BusinessProvisioningDeps = {
  isAccountOwner: realIsAccountOwner,
  deriveWalletAddress: (ownerPubkey) => computeAccountAddress(ownerPubkey, 0),
  deployWallet: (input) => executeSponsoredDeploy(input),

  createProvisioning: async (input) => assertLinked(await prisma.businessProvisioning.create({ data: input })),
  listProvisioning: async (apiClientId, status) =>
    (await prisma.businessProvisioning.findMany({ where: { apiClientId, ...(status ? { status } : {}) } })).map(assertLinked),
  getProvisioningById: async (id, apiClientId) => {
    const row = await prisma.businessProvisioning.findUnique({ where: { id } });
    return row && row.apiClientId === apiClientId ? assertLinked(row) : null;
  },
  getProvisioningByIdUnscoped: async (id) => {
    const row = await prisma.businessProvisioning.findUnique({ where: { id } });
    return row ? assertLinked(row) : null;
  },
  ensureRecipientAccount: async (recipientScheme, recipientValue) => {
    if (recipientScheme !== "email") return null;
    const { accountId } = await ensureAccountForEmail(recipientValue, "MEDIALANE_SDK");
    return accountId;
  },
  linkWalletToAccount: async ({ chain, walletAddress, accountId }) => {
    await ensureAccountForWallet({
      chain,
      address: walletAddress,
      provider: "mediawallet",
      appSource: "MEDIALANE_SDK",
      linkToAccountId: accountId,
    });
  },
  markTransferred: async (id) => assertLinked(await prisma.businessProvisioning.update({ where: { id }, data: { status: "TRANSFERRED" } })),
  recordNewOwnerPubkey: async (id, newOwnerPubkey) =>
    assertLinked(await prisma.businessProvisioning.update({ where: { id }, data: { newOwnerPubkey, status: "HANDOFF" } })),
};

export const businessProvisioningRoutes = createBusinessProvisioningRoutes(productionDeps);
