import { Hono } from "hono";
import { z } from "zod";
import { randomBytes } from "crypto";
import type { AppVariables } from "../../types/hono.js";
import { requirePlan } from "../middleware/tierGate.js";
import prisma from "../../db/client.js";
import { generateApiKey } from "../../utils/apiKey.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:portal");
const portal = new Hono<{ Variables: AppVariables }>();

// ---------------------------------------------------------------------------
// GET /v1/portal/me
// ---------------------------------------------------------------------------
portal.get("/me", async (c) => {
  const tenant = c.get("tenant");
  return c.json({
    data: {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
      plan: tenant.plan,
      status: tenant.status,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /v1/portal/keys
// ---------------------------------------------------------------------------
portal.get("/keys", async (c) => {
  const tenant = c.get("tenant");

  const keys = await prisma.apiKey.findMany({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      prefix: true,
      label: true,
      status: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });

  return c.json({ data: keys });
});

// ---------------------------------------------------------------------------
// POST /v1/portal/keys — create a new API key (max 5 keys per tenant)
// ---------------------------------------------------------------------------
const createKeySchema = z.object({ label: z.string().max(64).optional() });

portal.post("/keys", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json().catch(() => ({}));
  const parsed = createKeySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const keyCount = await prisma.apiKey.count({
    where: { tenantId: tenant.id, status: "ACTIVE" },
  });
  if (keyCount >= 5) {
    return c.json({ error: "Max 5 active API keys per tenant" }, 409);
  }

  const { plaintext, prefix, keyHash } = generateApiKey();
  const key = await prisma.apiKey.create({
    data: {
      tenantId: tenant.id,
      prefix,
      keyHash,
      label: parsed.data.label ?? undefined,
    },
  });

  log.info({ keyId: key.id, tenantId: tenant.id }, "Self-service API key created");
  return c.json({ data: { id: key.id, prefix, label: key.label, plaintext } }, 201);
});

// ---------------------------------------------------------------------------
// DELETE /v1/portal/keys/:id — revoke a key (scoped to tenant)
// ---------------------------------------------------------------------------
portal.delete("/keys/:id", async (c) => {
  const tenant = c.get("tenant");
  const { id } = c.req.param();

  const key = await prisma.apiKey.findFirst({
    where: { id, tenantId: tenant.id },
  });
  if (!key) return c.json({ error: "API key not found" }, 404);
  if (key.status === "REVOKED") return c.json({ error: "Key already revoked" }, 409);

  await prisma.apiKey.update({ where: { id }, data: { status: "REVOKED" } });
  log.info({ keyId: id, tenantId: tenant.id }, "API key revoked via portal");
  return c.json({ data: { id, status: "REVOKED" } });
});

// ---------------------------------------------------------------------------
// GET /v1/portal/usage — last 30 days grouped by day
// ---------------------------------------------------------------------------
portal.get("/usage", async (c) => {
  const tenant = c.get("tenant");
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);

  const rows = await prisma.$queryRaw<{ day: Date; requests: bigint }[]>`
    SELECT
      date_trunc('day', "createdAt") AS day,
      COUNT(*) AS requests
    FROM "UsageLog"
    WHERE "tenantId" = ${tenant.id}
      AND "createdAt" >= ${since}
    GROUP BY day
    ORDER BY day DESC
  `;

  return c.json({
    data: rows.map((r) => ({
      day: (r.day as Date).toISOString().slice(0, 10), // "YYYY-MM-DD" — avoids double-parse on client
      requests: Number(r.requests),
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /v1/portal/webhooks — PREMIUM only
// ---------------------------------------------------------------------------
portal.get("/webhooks", requirePlan("PREMIUM"), async (c) => {
  const tenant = c.get("tenant");

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      url: true,
      events: true,
      status: true,
      createdAt: true,
    },
  });

  return c.json({ data: endpoints });
});

// ---------------------------------------------------------------------------
// POST /v1/portal/webhooks — PREMIUM only; returns secret ONCE
// ---------------------------------------------------------------------------
const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z
    .array(z.enum(["ORDER_CREATED", "ORDER_FULFILLED", "ORDER_CANCELLED", "TRANSFER"]))
    .min(1),
  label: z.string().optional(),
});

portal.post("/webhooks", requirePlan("PREMIUM"), async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json().catch(() => null);
  const parsed = createWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { url, events } = parsed.data;

  // Generate a random signing secret (shown ONCE, stored in DB for HMAC)
  const secret = `whsec_${randomBytes(32).toString("hex")}`;

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      tenantId: tenant.id,
      url,
      secret,
      events: events as any,
    },
  });

  log.info({ endpointId: endpoint.id, tenantId: tenant.id }, "Webhook endpoint created");

  return c.json(
    {
      data: {
        id: endpoint.id,
        url: endpoint.url,
        events: endpoint.events,
        status: endpoint.status,
        // Secret shown ONCE — used to verify x-medialane-signature on deliveries
        secret,
      },
    },
    201
  );
});

// ---------------------------------------------------------------------------
// DELETE /v1/portal/webhooks/:id — PREMIUM only; scoped by tenantId
// ---------------------------------------------------------------------------
portal.delete("/webhooks/:id", requirePlan("PREMIUM"), async (c) => {
  const tenant = c.get("tenant");
  const { id } = c.req.param();

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id, tenantId: tenant.id },
  });

  if (!endpoint) {
    return c.json({ error: "Webhook endpoint not found" }, 404);
  }

  await prisma.webhookEndpoint.update({
    where: { id },
    data: { status: "DISABLED" },
  });

  return c.json({ data: { id, status: "DISABLED" } });
});

export default portal;
