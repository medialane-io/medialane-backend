import { apiKeyAuth } from "./apiKeyAuth.js";
import { apiKeyRateLimit } from "./rateLimit.js";
import { meter } from "./meter.js";

/**
 * The standard tenant-key chain: authenticate, apply the FREE-tier monthly
 * quota, then x402-meter the request. This is exactly what `server.ts` mounts
 * globally on `/v1/*` via `app.use("/v1/*", apiKeyAuth)` +
 * `app.use("/v1/*", apiKeyRateLimit())` + `app.use("/v1/*", meter())`.
 *
 * Routers that are mounted BEFORE that global chain (because they layer
 * Clerk JWT / SIWS auth on top of tenant auth — claims, username-claims,
 * collection-slug-claims, users, remix-offers) never receive it automatically
 * and must wire it in per-route. Spread this constant rather than repeating
 * the three middlewares by hand — that repetition is exactly how tenant auth,
 * quota, and metering silently went missing on those routers in the first
 * place (2026-06-30 audit finding). New routes on those routers: add
 * `...tenantGate` before the route's own JWT/SIWS auth.
 *
 * Deliberately NOT given an explicit array type — `as const` infers a fixed
 * 3-tuple, which is what lets Hono's `.get/.post(path, ...handlers)` overloads
 * resolve and keep typing `c.req.valid(...)` correctly for every route that
 * spreads this in. Annotating it as `MiddlewareHandler[]` widens the tuple to
 * a generic array and silently breaks that inference — don't add one back.
 */
export const tenantGate = [apiKeyAuth, apiKeyRateLimit(), meter()] as const;
