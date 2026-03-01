import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { authMiddleware } from "../middleware/auth.js";
import prisma from "../../db/client.js";
import { generateApiKey } from "../../utils/apiKey.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:admin");
const admin = new Hono();

// All admin routes require the admin secret
admin.use("*", authMiddleware);

// ---------------------------------------------------------------------------
// POST /admin/tenants — create tenant + initial API key
// ---------------------------------------------------------------------------
const createTenantSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  plan: z.enum(["FREE", "PREMIUM"]).default("FREE"),
  keyLabel: z.string().optional(),
});

admin.post("/tenants", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createTenantSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { name, email, plan, keyLabel } = parsed.data;

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
        create: { prefix, keyHash, label: keyLabel ?? "default" },
      },
    },
    include: { apiKeys: true },
  });

  await prisma.auditLog.create({
    data: {
      tenantId: tenant.id,
      actorType: "admin",
      actor: "system",
      action: "TENANT_CREATED",
      detail: { name, email, plan },
    },
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

  await prisma.auditLog.create({
    data: {
      tenantId: id,
      actorType: "admin",
      actor: "system",
      action: "TENANT_UPDATED",
      detail: parsed.data,
    },
  });

  return c.json({ data: { id, plan: updated.plan, status: updated.status } });
});

// ---------------------------------------------------------------------------
// GET /admin/usage — usage stats
// ---------------------------------------------------------------------------
admin.get("/usage", async (c) => {
  const tenantId = c.req.query("tenantId");
  const daysParam = parseInt(c.req.query("days") ?? "30", 10);
  const days = Math.min(Number.isFinite(daysParam) ? daysParam : 30, 90);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);

  const tenantFilter = tenantId
    ? Prisma.sql`AND "tenantId" = ${tenantId}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<
    { tenant_id: string; day: Date; requests: bigint }[]
  >`
    SELECT
      "tenantId"   AS tenant_id,
      date_trunc('day', "createdAt") AS day,
      COUNT(*)     AS requests
    FROM "UsageLog"
    WHERE "createdAt" >= ${since}
      ${tenantFilter}
    GROUP BY "tenantId", day
    ORDER BY day DESC
  `;

  return c.json({
    data: rows.map((r) => ({
      tenantId: r.tenant_id,
      day: (r.day as Date).toISOString().slice(0, 10),
      requests: Number(r.requests),
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /admin/tenants/:id/keys — create additional key
// ---------------------------------------------------------------------------
const createKeySchema = z.object({
  label: z.string().optional(),
});

admin.post("/tenants/:id/keys", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => null);
  const parsed = createKeySchema.safeParse(body ?? {});

  const tenant = await prisma.tenant.findUnique({ where: { id } });
  if (!tenant) return c.json({ error: "Tenant not found" }, 404);

  const { plaintext, prefix, keyHash } = generateApiKey();
  const label = parsed.success ? (parsed.data.label ?? "") : "";

  const apiKey = await prisma.apiKey.create({
    data: { tenantId: id, prefix, keyHash, label },
  });

  await prisma.auditLog.create({
    data: {
      tenantId: id,
      actorType: "admin",
      actor: "system",
      action: "API_KEY_CREATED",
      detail: { keyId: apiKey.id, label },
    },
  });

  return c.json(
    {
      data: {
        id: apiKey.id,
        prefix,
        label: apiKey.label,
        plaintext, // shown ONCE
      },
    },
    201
  );
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

  await prisma.auditLog.create({
    data: {
      tenantId: apiKey.tenantId,
      actorType: "admin",
      actor: "system",
      action: "API_KEY_REVOKED",
      detail: { keyId, prefix: apiKey.prefix },
    },
  });

  return c.json({ data: { id: keyId, status: "REVOKED" } });
});

export default admin;
