/**
 * Tenant API key authentication - the base layer for all /v1/* routes.
 *
 * Accepts either header (in this priority order):
 *   x-api-key: ml_live_...
 *   Authorization: Bearer ml_live_...
 *
 * `x-api-key` is checked first so routes that also need a Clerk JWT
 * (e.g. PATCH /v1/creators/:wallet/profile) can put the JWT in the
 * Authorization header without it being mis-treated as the API key.
 *
 * Looks up the key by hash, rejects when status !== ACTIVE on either the
 * key or its parent tenant, and stamps `apiKeyId` + `tenant` onto the
 * Hono context for downstream middleware (rateLimit, tierGate, etc.).
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { hashApiKey, hashApiKeyPlain } from "../../utils/apiKey.js";
import { env } from "../../config/env.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:apiKeyAuth");

const KEY_SELECT = {
  id: true,
  prefix: true,
  status: true,
  monthlyRequestCount: true,
  monthlyResetAt: true,
  tenant: {
    select: { id: true, name: true, email: true, plan: true, status: true },
  },
} as const;

export const apiKeyAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Prefer x-api-key header; fall back to Authorization: Bearer <key>
  // x-api-key takes priority because some endpoints send both x-api-key (tenant key)
  // and Authorization: Bearer (Clerk JWT) simultaneously — reading Authorization first
  // would cause the Clerk token to be treated as the API key and rejected.
  const authHeader = c.req.header("authorization");
  const raw =
    c.req.header("x-api-key")?.trim()
    ?? (authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null)
    ?? null;

  if (!raw) {
    return c.json({ error: "Missing API key" }, 401);
  }

  // Primary lookup: HMAC-SHA256 hash (or plain SHA-256 when HMAC_KEY is unset)
  let apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(raw) },
    select: KEY_SELECT,
  });

  // Backward-compatible fallback: if HMAC_KEY is set and primary lookup missed,
  // try plain SHA-256 to support keys that were hashed before HMAC was introduced
  // (any ApiKey row created before 2026-04-04 — see commit 261ed90).
  //
  // The warn-level log on a hit lets us track which legacy keys are still in
  // active use. Plan: once these logs are silent for ≥30d AND all pre-HMAC keys
  // have been rotated or revoked, drop the fallback path entirely (audit P2-4).
  if (!apiKey && env.HMAC_KEY) {
    apiKey = await prisma.apiKey.findUnique({
      where: { keyHash: hashApiKeyPlain(raw) },
      select: KEY_SELECT,
    });
    if (apiKey) {
      log.warn(
        {
          keyId: apiKey.id,
          keyPrefix: apiKey.prefix,
          tenantId: apiKey.tenant.id,
          tenantName: apiKey.tenant.name,
        },
        "apiKeyAuth: pre-HMAC key authenticated via plain-SHA-256 fallback — rotate this key to drop the fallback path",
      );
    }
  }

  if (!apiKey || apiKey.status !== "ACTIVE" || apiKey.tenant.status !== "ACTIVE") {
    return c.json({ error: "Invalid or revoked API key" }, 401);
  }

  // Fire-and-forget lastUsedAt update — never block the request
  prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => log.warn({ err }, "Failed to update lastUsedAt"));

  c.set("apiKey", apiKey);
  c.set("tenant", apiKey.tenant);

  await next();
};
