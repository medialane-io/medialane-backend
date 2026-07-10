import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../../middleware/adminSecretAuth.js";
import prisma from "../../../db/client.js";
import { generateApiKey } from "../../../utils/apiKey.js";
import { APP_SOURCE_INPUT, normalizeAppSource } from "../../../utils/appSource.js";
import { handleMetadataFetch } from "../../../orchestrator/metadata.js";
import { handleCollectionMetadataFetch } from "../../../orchestrator/collectionMetadata.js";
import { handleStatsUpdate } from "../../../orchestrator/stats.js";
import { runTransferFollowups } from "../../../orchestrator/transferFollowup.js";
import { worker } from "../../../orchestrator/worker.js";
import { createLogger } from "../../../utils/logger.js";
import { sendUsernameClaimApproved, sendUsernameClaimRejected } from "../../../utils/mailer.js";
import { normalizeAddress, normalizeHash } from "../../../utils/starknet.js";
import { handleOrderCreated, handleOrderCreated1155 } from "../../../mirror/handlers/orderCreated.js";
import { dispatchTransfer } from "../../../mirror/handlers/transfer.js";
import { parseEvents } from "../../../mirror/parser.js";
import { fetchMarketplaceReceiptEvents, fetchReceiptEvents } from "../../../utils/txVerifier.js";
import { ORDER_CREATED_SELECTOR, ZERO_ADDRESS, getTokenByAddress } from "../../../config/constants.js";
import { num } from "starknet";
import type { ParsedTransfer, ParsedTransferBatch, ParsedTransferSingle } from "../../../types/marketplace.js";

import { InMemoryRateLimitStore } from "../../middleware/rateLimit.js";
import { toErrorMessage } from "../../../utils/error.js";

const log = createLogger("routes:admin");

export function registerTenantRoutes(admin: Hono) {
// ---------------------------------------------------------------------------
// POST /admin/tenants — create tenant + initial API key
// ---------------------------------------------------------------------------
const APP_SOURCE = z.enum(APP_SOURCE_INPUT);

const createTenantSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  plan: z.enum(["FREE", "PREMIUM"]).default("FREE"),
  keyLabel: z.string().optional(),
  /** Which app the initial key is for. Omit for generic/SDK consumers. */
  keyAppSource: APP_SOURCE.optional(),
});

admin.post("/tenants", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createTenantSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { name, email, plan, keyLabel, keyAppSource } = parsed.data;

  const existing = await prisma.tenant.findUnique({ where: { email } });
  if (existing) {
    return c.json({ error: "Email already registered" }, 409);
  }

  const { plaintext, prefix, keyHash } = generateApiKey();

  const tenant = await prisma.tenant.create({
    data: {
      name,
      email,
      plan,
      apiKeys: {
        create: {
          prefix,
          keyHash,
          label: keyLabel ?? "default",
          appSource: keyAppSource ? normalizeAppSource(keyAppSource) : null,
        },
      },
    },
    include: { apiKeys: true },
  });

  log.info({ tenantId: tenant.id, email }, "Tenant created");

  return c.json(
    {
      data: {
        tenant: { id: tenant.id, name, email, plan, status: tenant.status },
        apiKey: {
          id: tenant.apiKeys[0].id,
          prefix,
          label: tenant.apiKeys[0].label,
          appSource: tenant.apiKeys[0].appSource,
          // Plaintext shown ONCE — not stored
          plaintext,
        },
      },
    },
    201
  );
});

// ---------------------------------------------------------------------------
// GET /admin/tenants — list all tenants
// ---------------------------------------------------------------------------
admin.get("/tenants", async (c) => {
  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { apiKeys: true } } },
  });

  return c.json({
    data: tenants.map((t) => ({
      id: t.id,
      name: t.name,
      email: t.email,
      plan: t.plan,
      status: t.status,
      keyCount: t._count.apiKeys,
      createdAt: t.createdAt,
    })),
  });
});

// ---------------------------------------------------------------------------
// PATCH /admin/tenants/:id — update plan or status
// ---------------------------------------------------------------------------
const updateTenantSchema = z.object({
  plan: z.enum(["FREE", "PREMIUM"]).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});

admin.patch("/tenants/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);
  const parsed = updateTenantSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  if (!parsed.data.plan && !parsed.data.status) {
    return c.json({ error: "Provide plan or status to update" }, 400);
  }

  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const updated = await prisma.tenant.update({
    where: { id },
    data: parsed.data,
  });

  return c.json({ data: { id, plan: updated.plan, status: updated.status } });
});

// ---------------------------------------------------------------------------
// POST /admin/tenants/:id/credits — grant/adjust a tenant's credit balance.
// Used to fund first-party platform tenants (the dapp/io/etc. run on granted
// credits, not external payments) and to top up or correct any tenant.
// `amount` is a signed integer delta; negative deducts (floored at 0).
// ---------------------------------------------------------------------------
const grantCreditsSchema = z.object({ amount: z.number().int() });

admin.post("/tenants/:id/credits", async (c) => {
  const { id } = c.req.param();
  const parsed = grantCreditsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Provide an integer `amount`" }, 400);

  const tenant = await prisma.tenant.findUnique({ where: { id }, select: { creditBalance: true } });
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const next = Math.max(0, tenant.creditBalance + parsed.data.amount);
  const updated = await prisma.tenant.update({
    where: { id },
    data: { creditBalance: next },
    select: { id: true, creditBalance: true },
  });
  log.info({ tenantId: id, delta: parsed.data.amount, balance: updated.creditBalance }, "admin credit grant");
  return c.json({ data: { id: updated.id, creditBalance: updated.creditBalance } });
});

// ---------------------------------------------------------------------------
// POST /admin/tenants/:id/keys — create additional key
// ---------------------------------------------------------------------------
const createKeySchema = z.object({
  label: z.string().optional(),
  /** Which app the key is for — drives per-app attribution and isolation. */
  appSource: APP_SOURCE.optional(),
});

admin.post("/tenants/:id/keys", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);
  const parsed = createKeySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const { plaintext, prefix, keyHash } = generateApiKey();

  const apiKey = await prisma.apiKey.create({
    data: {
      tenantId: id,
      prefix,
      keyHash,
      label: parsed.data.label ?? "",
      appSource: parsed.data.appSource ? normalizeAppSource(parsed.data.appSource) : null,
    },
  });

  return c.json(
    {
      data: {
        id: apiKey.id,
        prefix,
        label: apiKey.label,
        appSource: apiKey.appSource,
        plaintext, // shown ONCE
      },
    },
    201
  );
});

// ---------------------------------------------------------------------------
// GET /admin/tenants/:id/keys — list keys for a tenant (includes appSource)
// ---------------------------------------------------------------------------
admin.get("/tenants/:id/keys", async (c) => {
  const { id } = c.req.param();
  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const keys = await prisma.apiKey.findMany({
    where: { tenantId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      prefix: true,
      label: true,
      appSource: true,
      status: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });

  return c.json({ data: keys });
});

// ---------------------------------------------------------------------------
// DELETE /admin/keys/:keyId — revoke key (soft delete)
// ---------------------------------------------------------------------------
admin.delete("/keys/:keyId", async (c) => {
  const { keyId } = c.req.param();

  const apiKey = await prisma.apiKey.findUnique({
    where: { id: keyId },
    include: { tenant: true },
  });
  if (!apiKey) return c.json({ error: "Key not found" }, 404);

  await prisma.apiKey.update({
    where: { id: keyId },
    data: { status: "REVOKED" },
  });

  return c.json({ data: { id: keyId, status: "REVOKED" } });
});

// ---------------------------------------------------------------------------
}
