/**
 * x402 pricing admin — the portal's server-side interface for tuning credit
 * costs per action, chain, and service without a code deploy. Mirrors the
 * accounts.ts / RewardAction admin patterns.
 */
import type { Hono } from "hono";
import { z } from "zod";
import prisma from "../../../db/client.js";
import { invalidatePricingCache } from "../../../payments/pricing.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("routes:admin:pricing");

export function registerPricingRoutes(admin: Hono) {
  // GET /admin/pricing — every rule, most specific first (per actionKey).
  admin.get("/pricing", async (c) => {
    const rules = await prisma.pricingRule.findMany({
      orderBy: [{ actionKey: "asc" }, { chain: "asc" }, { service: "asc" }],
    });
    return c.json({ data: rules });
  });

  // PATCH /admin/pricing/:actionKey — upsert a price. Body: { credits, chain?,
  // service?, label? }. chain/service default to "ALL" (the wildcard
  // sentinel) — omit both to set the actionKey's chain-agnostic,
  // service-agnostic default; supply either to add/update a more specific
  // override. Takes effect immediately (cache invalidated on write).
  admin.patch("/pricing/:actionKey", async (c) => {
    const actionKey = c.req.param("actionKey");
    const body = await c.req.json().catch(() => null);
    const parsed = z.object({
      credits: z.number().int().min(0),
      chain: z.string().min(1).default("ALL"),
      service: z.string().min(1).default("ALL"),
      label: z.string().max(120).optional(),
    }).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "credits (int >= 0) is required; chain/service optional (default ALL)" }, 400);
    }
    const { credits, chain, service, label } = parsed.data;
    const rule = await prisma.pricingRule.upsert({
      where: { actionKey_chain_service: { actionKey, chain, service } },
      update: { credits, ...(label !== undefined ? { label } : {}) },
      create: { actionKey, chain, service, credits, label },
    });
    invalidatePricingCache();
    log.info({ actionKey, chain, service, credits }, "admin pricing update");
    return c.json({ data: rule });
  });

  // DELETE /admin/pricing/:actionKey?chain=&service= — remove a specific
  // override row (defaults to ALL/ALL if omitted). Removing the ALL/ALL row
  // for an actionKey drops it back to the hardcoded fallback in pricing.ts —
  // intentionally allowed (never leaves metering unable to resolve a price).
  admin.delete("/pricing/:actionKey", async (c) => {
    const actionKey = c.req.param("actionKey");
    const chain = c.req.query("chain") ?? "ALL";
    const service = c.req.query("service") ?? "ALL";
    try {
      await prisma.pricingRule.delete({
        where: { actionKey_chain_service: { actionKey, chain, service } },
      });
    } catch {
      return c.json({ error: "Pricing rule not found" }, 404);
    }
    invalidatePricingCache();
    log.info({ actionKey, chain, service }, "admin pricing rule removed");
    return c.json({ ok: true });
  });
}
