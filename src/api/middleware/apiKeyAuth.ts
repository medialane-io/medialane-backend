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
import { hashApiKey } from "../../utils/apiKey.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:apiKeyAuth");

// lastUsedAt is telemetry, not a ledger — writing it on every request turns
// each first-party app's key into a hot row (P-1, 2026-07-10 audit). Throttle
// to at most one write per key per interval; the map is bounded by the number
// of live keys.
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const lastUsedWrites = new Map<string, number>();

function touchLastUsed(keyId: string): void {
  const now = Date.now();
  if (now - (lastUsedWrites.get(keyId) ?? 0) < LAST_USED_WRITE_INTERVAL_MS) return;
  lastUsedWrites.set(keyId, now);
  // Fire-and-forget — never block the request
  prisma.apiKey
    .update({ where: { id: keyId }, data: { lastUsedAt: new Date() } })
    .catch((err) => log.warn({ err }, "Failed to update lastUsedAt"));
}

const KEY_SELECT = {
  id: true,
  prefix: true,
  status: true,
  // The billing identity (07-identity §III) — credits + plan live here.
  account: {
    select: { id: true, plan: true, status: true, creditBalance: true },
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

  // HMAC-SHA256 lookup — the only path. The legacy plain-SHA-256 fallback
  // (in place 2026-04-04 → 2026-05-24) was removed once all pre-HMAC keys
  // were rotated. Audit P2-4. If you're staring at this comment because
  // someone needs the old format back, see the rotation playbook:
  // medialane-core/docs/plans/2026-05-24-apikey-per-app-rotation.md
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(raw) },
    select: KEY_SELECT,
  });

  // Key is valid only if active AND bound to an active Account — the billing
  // identity (07 §III). Tenant is gone (Phase D cutover, 2026-07-12).
  if (!apiKey || apiKey.status !== "ACTIVE" || apiKey.account.status !== "ACTIVE") {
    return c.json({ error: "Invalid or revoked API key" }, 401);
  }

  touchLastUsed(apiKey.id);

  c.set("apiKey", apiKey);
  c.set("account", apiKey.account);

  await next();
};
