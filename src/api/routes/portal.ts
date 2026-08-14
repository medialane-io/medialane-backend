import { Hono } from "hono";
import { z } from "zod";
import { randomBytes } from "crypto";
import type { AppVariables } from "../../types/hono.js";
import { requirePlan } from "../middleware/tierGate.js";
import prisma from "../../db/client.js";
import { generateApiKey } from "../../utils/apiKey.js";
import { APP_SOURCE_INPUT, normalizeAppSource } from "../../utils/appSource.js";
import { createLogger } from "../../utils/logger.js";
import { isPrivateOrInsecureUrl } from "../../utils/ssrf.js";
import { settlePayment } from "../../payments/x402.js";
import { StarknetUsdcScheme } from "../../payments/schemes/starknet.js";

const log = createLogger("routes:portal");
const portal = new Hono<{ Variables: AppVariables }>();
const starknetScheme = new StarknetUsdcScheme();

portal.get("/me", async (c) => {
  const account = c.get("account");
  const apiClient = c.get("apiClient");
  return c.json({
    data: {
      id: apiClient.id,
      accountId: apiClient.accountId,
      plan: apiClient.plan,
      status: account.status,
      creditBalance: apiClient.creditBalance,
    },
  });
});

portal.post("/credits/fund", async (c) => {
  const apiClient = c.get("apiClient");
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ txHash: z.string().min(3) }).safeParse(body);
  if (!parsed.success) return c.json({ error: "txHash is required" }, 400);

  const result = await settlePayment(starknetScheme, apiClient, {
    scheme: starknetScheme.scheme,
    network: starknetScheme.network,
    txHash: parsed.data.txHash,
    nonce: "portal-fund",
  });
  if (!result.ok) return c.json({ error: result.reason ?? "Payment verification failed" }, 402);
  return c.json({ data: { credited: result.creditedAmount ?? 0 } });
});

portal.get("/credits/history", async (c) => {
  const apiClient = c.get("apiClient");
  const payments = await prisma.payment.findMany({
    where: { apiClientId: apiClient.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      amountAtomic: true,
      creditedAmount: true,
      mdlnMultiplier: true,
      txHash: true,
      status: true,
      createdAt: true,
    },
  });
  return c.json({ data: payments });
});

portal.get("/keys", async (c) => {
  const apiClient = c.get("apiClient");

  const keys = await prisma.apiKey.findMany({
    where: { apiClientId: apiClient.id },
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

const createKeySchema = z.object({
  label: z.string().max(64).optional(),

  appSource: z.enum(APP_SOURCE_INPUT).optional(),
});

portal.post("/keys", async (c) => {
  const apiClient = c.get("apiClient");
  const body = await c.req.json().catch(() => ({}));
  const parsed = createKeySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  let plaintext: string;
  let key;
  try {
    key = await prisma.$transaction(async (tx) => {
      const keyCount = await tx.apiKey.count({
        where: { apiClientId: apiClient.id, status: "ACTIVE" },
      });
      if (keyCount >= 5) {
        throw Object.assign(new Error("Max 5 active API keys per account"), { code: "KEY_LIMIT" });
      }
      const generated = generateApiKey();
      plaintext = generated.plaintext;
      return tx.apiKey.create({
        data: {
          apiClientId: apiClient.id,
          prefix: generated.prefix,
          keyHash: generated.keyHash,
          label: parsed.data.label ?? undefined,
          appSource: parsed.data.appSource ? normalizeAppSource(parsed.data.appSource) : null,
        },
      });
    });
  } catch (err: any) {
    if (err.code === "KEY_LIMIT") return c.json({ error: "Max 5 active API keys per account" }, 409);
    throw err;
  }

  log.info({ keyId: key.id, apiClientId: apiClient.id, appSource: key.appSource }, "Self-service API key created");
  return c.json({ data: { id: key.id, prefix: key.prefix, label: key.label, appSource: key.appSource, plaintext: plaintext! } }, 201);
});

portal.delete("/keys/:id", async (c) => {
  const apiClient = c.get("apiClient");
  const { id } = c.req.param();

  const key = await prisma.apiKey.findFirst({
    where: { id, apiClientId: apiClient.id },
  });
  if (!key) return c.json({ error: "API key not found" }, 404);
  if (key.status === "REVOKED") return c.json({ error: "Key already revoked" }, 409);

  await prisma.apiKey.update({ where: { id }, data: { status: "REVOKED" } });
  log.info({ keyId: id, apiClientId: apiClient.id }, "API key revoked via portal");
  return c.json({ data: { id, status: "REVOKED" } });
});

portal.get("/webhooks", requirePlan("PREMIUM"), async (c) => {
  const apiClient = c.get("apiClient");

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { apiClientId: apiClient.id },
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

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z
    .array(z.enum(["ORDER_CREATED", "ORDER_FULFILLED", "ORDER_CANCELLED", "TRANSFER"]))
    .min(1),
  label: z.string().optional(),
});

portal.post("/webhooks", requirePlan("PREMIUM"), async (c) => {
  const apiClient = c.get("apiClient");
  const body = await c.req.json().catch(() => null);
  const parsed = createWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.flatten() }, 400);
  }

  const { url, events } = parsed.data;

  if (isPrivateOrInsecureUrl(url)) {
    return c.json({ error: "Webhook URL must be a public https:// address" }, 400);
  }

  const secret = `whsec_${randomBytes(32).toString("hex")}`;

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      apiClientId: apiClient.id,
      url,
      secret,
      events: events as any,
    },
  });

  log.info({ endpointId: endpoint.id, apiClientId: apiClient.id }, "Webhook endpoint created");

  return c.json(
    {
      data: {
        id: endpoint.id,
        url: endpoint.url,
        events: endpoint.events,
        status: endpoint.status,

        secret,
      },
    },
    201
  );
});

portal.delete("/webhooks/:id", requirePlan("PREMIUM"), async (c) => {
  const apiClient = c.get("apiClient");
  const { id } = c.req.param();

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id, apiClientId: apiClient.id },
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
