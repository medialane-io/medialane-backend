import type { MiddlewareHandler, Context, Next } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { apiKeyRateLimit } from "./rateLimit.js";
import { meter } from "./meter.js";

/**
 * Paths under `/v1/*` that intentionally bypass API-key auth entirely.
 * This is the ONE place that decision is made — not mount order in server.ts.
 * Keep in sync with `medialane-sdk/src/api/client.ts`: every call site NOT
 * listed here is expected to send `x-api-key`.
 *
 * See medialane-core/docs/specs/2026-06-30-tenant-gate-global-middleware-design.md.
 */
const PUBLIC_V1_PATHS: ReadonlyArray<{ method?: string; pattern: RegExp }> = [
  { method: "GET", pattern: /^\/v1\/username-claims\/check\/[^/]+$/ },
  { method: "GET", pattern: /^\/v1\/collection-slug-claims\/check\/[^/]+$/ },
  { method: "GET", pattern: /^\/v1\/users\/me$/ },
  { method: "POST", pattern: /^\/v1\/users\/me$/ },
  { pattern: /^\/v1\/auth\/siws\// },
];

function isPublicV1Path(method: string, path: string): boolean {
  return PUBLIC_V1_PATHS.some((p) => (!p.method || p.method === method) && p.pattern.test(path));
}

/**
 * Chains a fixed list of middlewares into one, in order. Each handler's
 * return value must be propagated (not just awaited) — a middleware that
 * short-circuits by returning a Response directly (e.g. apiKeyAuth's 401)
 * needs that Response to reach Hono's own dispatcher, or the request is
 * left unfinalized ("Context is not finalized" error).
 */
function composeMiddleware(handlers: readonly MiddlewareHandler<AppEnv>[]): MiddlewareHandler<AppEnv> {
  return function chained(c: Context<AppEnv>, next: Next) {
    const run = (i: number): Promise<Response | void> => {
      if (i >= handlers.length) return Promise.resolve(next());
      // Hono's `Next` type is `() => Promise<void>`, but at runtime it only
      // matters whether a handler short-circuits by returning a Response —
      // the resolved value of `next()` itself is never read by callers. Cast
      // rather than widen `Next`, which would ripple into every other
      // middleware's signature.
      return Promise.resolve(handlers[i](c, (() => run(i + 1)) as Next));
    };
    return run(0);
  };
}

const gate = composeMiddleware([apiKeyAuth, apiKeyRateLimit(), meter()]);

/**
 * The API-key gate for every `/v1/*` route: authenticate, apply the
 * per-minute rate limit, then x402-meter — except the explicit public
 * paths above. Mount this FIRST on `/v1/*`, before any `/v1/*` router, so
 * gating no longer depends on registration order (2026-06-30 audit + design
 * spec — this replaced a pattern where routers mounted before the old
 * per-path `app.use` chain silently skipped it for months).
 */
export const apiKeyGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isPublicV1Path(c.req.method, c.req.path)) return next();
  return gate(c, next);
};
