import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { IDENTITY_SCHEME } from "../../utils/identity.js";
import { computeAccountAddress, buildAddOwnerCall, buildRemoveOwnerCall } from "@medialane/sdk/starknet";
import { executeSponsoredDeploy } from "./paymaster.js";
import { ensureAccountForIdentity, ensureAccountForWallet } from "../../utils/account.js";
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
  findAccountWallet: (chain: Chain, accountId: string) => Promise<string | null>;
  linkWalletToAccount: (input: { chain: Chain; walletAddress: string; accountId: string }) => Promise<void>;
  createProvisioning: (input: {
    apiClientId: string; accountId: string; chain: Chain; walletAddress: string; recipientScheme: string; recipientValue: string; interimOwnerPubkey: string;
  }) => Promise<ProvisioningRecord>;
  listProvisioning: (apiClientId: string, status?: ProvisioningStatus) => Promise<ProvisioningRecord[]>;
  getProvisioningById: (id: string, apiClientId: string) => Promise<ProvisioningRecord | null>;
  getProvisioningByIdUnscoped: (id: string) => Promise<ProvisioningRecord | null>;
  markTransferred: (id: string) => Promise<ProvisioningRecord>;
  recordNewOwnerPubkey: (id: string, newOwnerPubkey: string) => Promise<ProvisioningRecord>;
  getProvisioningByWallet: (chain: Chain, walletAddress: string) => Promise<ProvisioningRecord | null>;
}

const FELT = /^0x[0-9a-fA-F]{1,64}$/;

const handoffSchema = z.object({
  chain: z.enum(["STARKNET"]).default("STARKNET"),
  walletAddress: z.string(),
  newOwnerPubkey: z.string().regex(FELT),
});

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

    const recipientAccountId = await deps.ensureRecipientAccount(recipientScheme, recipientValue);

    const existingWallet = recipientAccountId
      ? await deps.findAccountWallet(chain, recipientAccountId)
      : null;

    if (existingWallet) {
      const record = await deps.createProvisioning({
        apiClientId: apiClient.id,
        accountId: apiClient.accountId,
        chain,
        walletAddress: existingWallet,
        recipientScheme,
        recipientValue,
        interimOwnerPubkey: normPubkey,
      });
      return c.json({ data: record, reusedExistingWallet: true }, 200);
    }

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

  app.post("/handoff", zValidator("json", handoffSchema), async (c) => {
    const { chain, walletAddress, newOwnerPubkey } = c.req.valid("json");
    const normWallet = normalizeAddress(chain, walletAddress);

    const record = await deps.getProvisioningByWallet(chain, normWallet);
    if (!record) return c.json({ error: "not_found" }, 404);
    if (record.status === "TRANSFERRED") return c.json({ error: "already_transferred" }, 409);

    const updated = await deps.recordNewOwnerPubkey(record.id, normalizeAddress(chain, newOwnerPubkey));
    return c.json({ data: updated });
  });

  app.get("/:id/handoff-calls", async (c) => {
    const id = c.req.param("id");
    const apiClient = c.get("apiClient");
    const record = await deps.getProvisioningById(id, apiClient.id);
    if (!record) return c.json({ error: "not_found" }, 404);
    if (!record.newOwnerPubkey) return c.json({ error: "no_recipient_key_yet" }, 409);

    return c.json({
      data: {
        addRecipient: buildAddOwnerCall(record.walletAddress, record.newOwnerPubkey),
        removeInterim: buildRemoveOwnerCall(record.walletAddress, record.interimOwnerPubkey),
      },
    });
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
  findAccountWallet: async (chain, accountId) => {
    const identity = await prisma.identity.findFirst({
      where: { accountId, chain, scheme: IDENTITY_SCHEME.WALLET, address: { not: null } },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { address: true },
    });
    return identity?.address ?? null;
  },
  ensureRecipientAccount: async (recipientScheme, recipientValue) => {
    const { accountId } = await ensureAccountForIdentity(recipientScheme, recipientValue, "MEDIALANE_SDK");
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
    assertLinked(
      await prisma.businessProvisioning.update({
        where: { id },
        data: { newOwnerPubkey, status: "HANDOFF" },
      }),
    ),
  getProvisioningByWallet: async (chain, walletAddress) => {
    const row = await prisma.businessProvisioning.findUnique({
      where: { chain_walletAddress: { chain, walletAddress } },
    });
    return row ? assertLinked(row) : null;
  },
};

export const businessProvisioningRoutes = createBusinessProvisioningRoutes(productionDeps);
