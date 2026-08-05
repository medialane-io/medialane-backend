/**
 * ApiClient-scoped admin endpoints — billing (keys/credits/usage). Split out
 * of accounts.ts — see docs/superpowers/specs/2026-08-05-api-client-model-design.md.
 * Same "master key + id" auth shape as accounts.ts, keyed on ApiClient id.
 */
import type { Hono } from "hono";
import { z } from "zod";
import prisma from "../../../db/client.js";
import { generateApiKey } from "../../../utils/apiKey.js";
import { settlePayment } from "../../../payments/x402.js";
import { StarknetUsdcScheme } from "../../../payments/schemes/starknet.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("routes:admin:apiClients");
const starknetScheme = new StarknetUsdcScheme();

export function registerApiClientRoutes(admin: Hono) {
  // POST /admin/api-clients — grant an existing Account API-client (billing)
  // capability. This IS the "onboard an SDK/API consumer" action — the
  // Account must already exist (every ApiClient requires one, never the
  // reverse); this just attaches the billing facet to it.
  admin.post("/api-clients", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ accountId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return c.json({ error: "accountId is required" }, 400);

    const account = await prisma.account.findUnique({ where: { id: parsed.data.accountId }, select: { id: true } });
    if (!account) return c.json({ error: "Account not found" }, 404);

    const existing = await prisma.apiClient.findUnique({ where: { accountId: parsed.data.accountId }, select: { id: true } });
    if (existing) return c.json({ error: "This account already has an ApiClient" }, 409);

    const apiClient = await prisma.apiClient.create({
      data: { accountId: parsed.data.accountId },
      select: { id: true, accountId: true, plan: true, creditBalance: true },
    });
    log.info({ apiClientId: apiClient.id, accountId: parsed.data.accountId }, "admin created ApiClient");
    return c.json({ data: apiClient }, 201);
  });

  // PATCH /admin/api-clients/:id — update plan.
  admin.patch("/api-clients/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ plan: z.enum(["FREE", "PREMIUM"]).optional() }).safeParse(body);
    if (!parsed.success || !parsed.data.plan) {
      return c.json({ error: "Provide plan" }, 400);
    }
    try {
      const apiClient = await prisma.apiClient.update({
        where: { id: c.req.param("id") },
        data: parsed.data,
        select: { id: true, accountId: true, plan: true, creditBalance: true },
      });
      log.info({ apiClientId: apiClient.id, ...parsed.data }, "admin api-client update");
      return c.json({ data: apiClient });
    } catch {
      return c.json({ error: "ApiClient not found" }, 404);
    }
  });

  // GET /admin/api-clients/:id/keys — list the ApiClient's keys (no plaintext).
  admin.get("/api-clients/:id/keys", async (c) => {
    const keys = await prisma.apiKey.findMany({
      where: { apiClientId: c.req.param("id") },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, prefix: true, label: true, appSource: true,
        status: true, lastUsedAt: true, createdAt: true,
      },
    });
    return c.json({ data: keys });
  });

  // POST /admin/api-clients/:id/keys — mint a key (plaintext shown ONCE). Max 5 active.
  admin.post("/api-clients/:id/keys", async (c) => {
    const apiClientId = c.req.param("id");
    const apiClient = await prisma.apiClient.findUnique({ where: { id: apiClientId }, select: { id: true, accountId: true } });
    if (!apiClient) return c.json({ error: "ApiClient not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ label: z.string().max(64).optional() }).safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid body" }, 400);

    const active = await prisma.apiKey.count({ where: { apiClientId, status: "ACTIVE" } });
    if (active >= 5) return c.json({ error: "Max 5 active API keys per account" }, 409);

    const { plaintext, prefix, keyHash } = generateApiKey();
    const key = await prisma.apiKey.create({
      // accountId is still NOT NULL until the drop-old-columns migration
      // phase — dual-write both while that column exists.
      data: { accountId: apiClient.accountId, apiClientId, prefix, keyHash, label: parsed.data.label ?? "default" },
      select: { id: true, prefix: true, label: true },
    });
    log.info({ keyId: key.id, apiClientId }, "admin minted api-client key");
    return c.json({ data: { id: key.id, prefix: key.prefix, label: key.label, plaintext } }, 201);
  });

  // DELETE /admin/api-clients/:id/keys/:keyId — revoke (soft).
  admin.delete("/api-clients/:id/keys/:keyId", async (c) => {
    const res = await prisma.apiKey.updateMany({
      where: { id: c.req.param("keyId"), apiClientId: c.req.param("id") },
      data: { status: "REVOKED" },
    });
    if (res.count === 0) return c.json({ error: "API key not found" }, 404);
    return c.json({ ok: true });
  });

  // GET /admin/api-clients/:id/credits — balance + recent ledger.
  admin.get("/api-clients/:id/credits", async (c) => {
    const apiClientId = c.req.param("id");
    const apiClient = await prisma.apiClient.findUnique({ where: { id: apiClientId }, select: { creditBalance: true } });
    if (!apiClient) return c.json({ error: "ApiClient not found" }, 404);
    const history = await prisma.payment.findMany({
      where: { apiClientId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, amountAtomic: true, creditedAmount: true, mdlnMultiplier: true, txHash: true, status: true, createdAt: true },
    });
    return c.json({ data: { balance: apiClient.creditBalance, history } });
  });

  // POST /admin/api-clients/:id/credits/fund — verify an on-chain USDC transfer and credit.
  admin.post("/api-clients/:id/credits/fund", async (c) => {
    const apiClientId = c.req.param("id");
    const apiClient = await prisma.apiClient.findUnique({ where: { id: apiClientId }, select: { id: true, accountId: true } });
    if (!apiClient) return c.json({ error: "ApiClient not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ txHash: z.string().min(3) }).safeParse(body);
    if (!parsed.success) return c.json({ error: "txHash is required" }, 400);
    const result = await settlePayment(starknetScheme, apiClient, {
      scheme: starknetScheme.scheme,
      network: starknetScheme.network,
      txHash: parsed.data.txHash,
      nonce: "admin-account-fund",
    });
    if (!result.ok) return c.json({ error: result.reason ?? "Payment verification failed" }, 402);
    return c.json({ data: { credited: result.creditedAmount ?? 0 } });
  });

  // POST /admin/api-clients/:id/credits/grant — admin credit adjustment
  // (granted credits for first-party apps). Floors at 0.
  admin.post("/api-clients/:id/credits/grant", async (c) => {
    const apiClientId = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({ amount: z.number().int() }).safeParse(body);
    if (!parsed.success) return c.json({ error: "amount (int) is required" }, 400);
    const apiClient = await prisma.apiClient.findUnique({ where: { id: apiClientId }, select: { creditBalance: true } });
    if (!apiClient) return c.json({ error: "ApiClient not found" }, 404);
    const next = Math.max(0, apiClient.creditBalance + parsed.data.amount);
    const updated = await prisma.apiClient.update({
      where: { id: apiClientId },
      data: { creditBalance: next },
      select: { id: true, creditBalance: true },
    });
    log.info({ apiClientId, delta: parsed.data.amount, balance: updated.creditBalance }, "admin credit grant");
    return c.json({ data: { id: updated.id, creditBalance: updated.creditBalance } });
  });

  // GET /admin/api-clients/:id/usage — per-key last-use telemetry. The old
  // monthly request counters were FREE-tier quota state; nothing has written
  // them since x402 credits became the meter (no free tier), so they were
  // dropped rather than served stale. Usage-in-credits lives on the Payment
  // ledger + ApiClient.creditBalance.
  admin.get("/api-clients/:id/usage", async (c) => {
    const keys = await prisma.apiKey.findMany({
      where: { apiClientId: c.req.param("id") },
      orderBy: { createdAt: "desc" },
      select: { prefix: true, label: true, status: true, lastUsedAt: true },
    });
    return c.json({ data: { keys } });
  });
}
