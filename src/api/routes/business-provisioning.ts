import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { isAccountOwner as realIsAccountOwner } from "../../chainRead/index.js";
import { sendProvisioningClaimEmail as realSendClaimEmail } from "../../utils/mailer.js";
import crypto from "crypto";
import type { Chain, ProvisioningStatus } from "@prisma/client";

export interface ProvisioningRecord {
  id: string;
  accountId: string;
  chain: Chain;
  walletAddress: string;
  recipientEmail: string;
  interimOwnerPubkey: string;
  newOwnerPubkey: string | null;
  status: ProvisioningStatus;
}

export interface BusinessProvisioningDeps {
  isAccountOwner: (chain: Chain, walletAddress: string, ownerPubkey: string) => Promise<boolean>;
  createProvisioning: (input: {
    accountId: string; chain: Chain; walletAddress: string; recipientEmail: string; interimOwnerPubkey: string;
  }) => Promise<ProvisioningRecord>;
  listProvisioning: (accountId: string, status?: ProvisioningStatus) => Promise<ProvisioningRecord[]>;
  getProvisioningById: (id: string, accountId: string) => Promise<ProvisioningRecord | null>;
  markClaimed: (id: string) => Promise<ProvisioningRecord>;
  recordNewOwnerPubkey: (id: string, newOwnerPubkey: string) => Promise<ProvisioningRecord>;
  createClaimToken: (input: { provisioningId: string }) => Promise<{ token: string; expiresAt: Date }>;
  sendClaimEmail: (to: string, claimUrl: string) => Promise<void>;
}

const registerSchema = z.object({
  chain: z.enum(["STARKNET"]).default("STARKNET"),
  walletAddress: z.string(),
  recipientEmail: z.string().email(),
  interimOwnerPubkey: z.string(),
});

export function createBusinessProvisioningRoutes(deps: BusinessProvisioningDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", zValidator("json", registerSchema), async (c) => {
    const { chain, walletAddress, recipientEmail, interimOwnerPubkey } = c.req.valid("json");
    const accountId = c.get("account").id;
    const normWallet = normalizeAddress(chain, walletAddress);
    const normPubkey = normalizeAddress(chain, interimOwnerPubkey);

    const ok = await deps.isAccountOwner(chain, normWallet, normPubkey);
    if (!ok) return c.json({ error: "interim_owner_mismatch" }, 400);

    const record = await deps.createProvisioning({
      accountId, chain, walletAddress: normWallet, recipientEmail, interimOwnerPubkey: normPubkey,
    });

    const { token } = await deps.createClaimToken({ provisioningId: record.id });
    const claimUrl = `https://medialane.io/claim/${token}`;
    await deps.sendClaimEmail(recipientEmail, claimUrl);

    return c.json({ data: record }, 201);
  });

  app.get("/", async (c) => {
    const accountId = c.get("account").id;
    const status = c.req.query("status") as ProvisioningStatus | undefined;
    const rows = await deps.listProvisioning(accountId, status);
    return c.json({ data: rows });
  });

  return app;
}

const productionDeps: BusinessProvisioningDeps = {
  isAccountOwner: realIsAccountOwner,
  createProvisioning: (input) => prisma.businessProvisioning.create({ data: input }),
  listProvisioning: (accountId, status) =>
    prisma.businessProvisioning.findMany({ where: { accountId, ...(status ? { status } : {}) } }),
  getProvisioningById: async (id, accountId) => {
    const row = await prisma.businessProvisioning.findUnique({ where: { id } });
    return row && row.accountId === accountId ? row : null;
  },
  markClaimed: (id) => prisma.businessProvisioning.update({ where: { id }, data: { status: "CLAIMED" } }),
  recordNewOwnerPubkey: (id, newOwnerPubkey) =>
    prisma.businessProvisioning.update({ where: { id }, data: { newOwnerPubkey, status: "CLAIM_PENDING" } }),
  createClaimToken: async ({ provisioningId }) => {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.provisioningClaimToken.create({ data: { provisioningId, token, expiresAt } });
    return { token, expiresAt };
  },
  sendClaimEmail: realSendClaimEmail,
};

export const businessProvisioningRoutes = createBusinessProvisioningRoutes(productionDeps);
