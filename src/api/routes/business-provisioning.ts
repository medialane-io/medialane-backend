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
  recipientScheme: string;
  recipientValue: string;
  interimOwnerPubkey: string;
  newOwnerPubkey: string | null;
  status: ProvisioningStatus;
}

export interface BusinessProvisioningDeps {
  isAccountOwner: (chain: Chain, walletAddress: string, ownerPubkey: string) => Promise<boolean>;
  createProvisioning: (input: {
    accountId: string; chain: Chain; walletAddress: string; recipientScheme: string; recipientValue: string; interimOwnerPubkey: string;
  }) => Promise<ProvisioningRecord>;
  listProvisioning: (accountId: string, status?: ProvisioningStatus) => Promise<ProvisioningRecord[]>;
  getProvisioningById: (id: string, accountId: string) => Promise<ProvisioningRecord | null>;
  getProvisioningByIdUnscoped: (id: string) => Promise<ProvisioningRecord | null>;
  markTransferred: (id: string) => Promise<ProvisioningRecord>;
  recordNewOwnerPubkey: (id: string, newOwnerPubkey: string) => Promise<ProvisioningRecord>;
  createClaimToken: (input: { provisioningId: string }) => Promise<{ token: string; expiresAt: Date }>;
  findClaimToken: (token: string) => Promise<{ provisioningId: string; expiresAt: Date; consumedAt: Date | null } | null>;
  consumeClaimToken: (token: string) => Promise<void>;
  sendClaimEmail: (to: string, claimUrl: string) => Promise<void>;
}

// recipientScheme is deliberately free-form (mirrors Identity.scheme, 07-identity §II —
// the platform never enumerates valid identity types). "email" is the only scheme this
// route knows how to deliver on our own behalf; every other scheme still registers and
// gets a claimUrl back in the response, delivery is the caller's own responsibility.
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
    const accountId = c.get("account").id;
    const normWallet = normalizeAddress(chain, walletAddress);
    const normPubkey = normalizeAddress(chain, interimOwnerPubkey);

    const ok = await deps.isAccountOwner(chain, normWallet, normPubkey);
    if (!ok) return c.json({ error: "interim_owner_mismatch" }, 400);

    const record = await deps.createProvisioning({
      accountId, chain, walletAddress: normWallet, recipientScheme, recipientValue, interimOwnerPubkey: normPubkey,
    });

    const { token } = await deps.createClaimToken({ provisioningId: record.id });
    const claimUrl = `https://medialane.io/claim/${token}`;
    // "email" is the only scheme we deliver on the business's behalf; every other
    // scheme still gets claimUrl back below for the business to deliver itself.
    if (recipientScheme === "email") await deps.sendClaimEmail(recipientValue, claimUrl);

    return c.json({ data: { ...record, claimUrl } }, 201);
  });

  app.get("/", async (c) => {
    const accountId = c.get("account").id;
    const status = c.req.query("status") as ProvisioningStatus | undefined;
    const rows = await deps.listProvisioning(accountId, status);
    return c.json({ data: rows });
  });

  app.get("/claim/:token", async (c) => {
    const token = c.req.param("token");
    const claim = await deps.findClaimToken(token);
    if (!claim) return c.json({ error: "not_found" }, 404);
    if (claim.consumedAt || claim.expiresAt < new Date()) return c.json({ error: "expired" }, 410);
    const record = await deps.getProvisioningByIdUnscoped(claim.provisioningId);
    if (!record) return c.json({ error: "not_found" }, 404);
    return c.json({ data: { chain: record.chain, walletAddress: record.walletAddress, recipientScheme: record.recipientScheme, recipientValue: record.recipientValue } });
  });

  app.post("/claim/:token", zValidator("json", z.object({ newOwnerPubkey: z.string() })), async (c) => {
    const token = c.req.param("token");
    const { newOwnerPubkey } = c.req.valid("json");
    const claim = await deps.findClaimToken(token);
    if (!claim) return c.json({ error: "not_found" }, 404);
    if (claim.consumedAt || claim.expiresAt < new Date()) return c.json({ error: "expired" }, 410);

    const record = await deps.recordNewOwnerPubkey(claim.provisioningId, normalizeAddress("STARKNET", newOwnerPubkey));
    await deps.consumeClaimToken(token);
    return c.json({ data: record });
  });

  app.post("/:id/complete", async (c) => {
    const id = c.req.param("id");
    const accountId = c.get("account").id;
    const record = await deps.getProvisioningById(id, accountId);
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

const productionDeps: BusinessProvisioningDeps = {
  isAccountOwner: realIsAccountOwner,
  createProvisioning: (input) => prisma.businessProvisioning.create({ data: input }),
  listProvisioning: (accountId, status) =>
    prisma.businessProvisioning.findMany({ where: { accountId, ...(status ? { status } : {}) } }),
  getProvisioningById: async (id, accountId) => {
    const row = await prisma.businessProvisioning.findUnique({ where: { id } });
    return row && row.accountId === accountId ? row : null;
  },
  getProvisioningByIdUnscoped: (id) => prisma.businessProvisioning.findUnique({ where: { id } }),
  markTransferred: (id) => prisma.businessProvisioning.update({ where: { id }, data: { status: "TRANSFERRED" } }),
  recordNewOwnerPubkey: (id, newOwnerPubkey) =>
    prisma.businessProvisioning.update({ where: { id }, data: { newOwnerPubkey, status: "HANDOFF" } }),
  createClaimToken: async ({ provisioningId }) => {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.provisioningClaimToken.create({ data: { provisioningId, token, expiresAt } });
    return { token, expiresAt };
  },
  findClaimToken: (token) => prisma.provisioningClaimToken.findUnique({ where: { token } }),
  consumeClaimToken: async (token) => {
    await prisma.provisioningClaimToken.update({ where: { token }, data: { consumedAt: new Date() } });
  },
  sendClaimEmail: realSendClaimEmail,
};

export const businessProvisioningRoutes = createBusinessProvisioningRoutes(productionDeps);
