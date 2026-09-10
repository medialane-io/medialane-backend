import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
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
  walletAddress: z.string(),
  recipientScheme: z.string().min(1),
  recipientValue: z.string().min(1),
  interimOwnerPubkey: z.string(),
});

export function createBusinessProvisioningRoutes(deps: BusinessProvisioningDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", zValidator("json", registerSchema), async (c) => {
    const { chain, walletAddress, recipientScheme, recipientValue, interimOwnerPubkey } = c.req.valid("json");
    const apiClient = c.get("apiClient");
    const normWallet = normalizeAddress(chain, walletAddress);
    const normPubkey = normalizeAddress(chain, interimOwnerPubkey);

    const ok = await deps.isAccountOwner(chain, normWallet, normPubkey);
    if (!ok) return c.json({ error: "interim_owner_mismatch" }, 400);

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
  markTransferred: async (id) => assertLinked(await prisma.businessProvisioning.update({ where: { id }, data: { status: "TRANSFERRED" } })),
  recordNewOwnerPubkey: async (id, newOwnerPubkey) =>
    assertLinked(await prisma.businessProvisioning.update({ where: { id }, data: { newOwnerPubkey, status: "HANDOFF" } })),
};

export const businessProvisioningRoutes = createBusinessProvisioningRoutes(productionDeps);
