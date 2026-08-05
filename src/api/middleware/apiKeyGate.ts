import type { MiddlewareHandler, Context, Next } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { apiKeyAuth } from "./apiKeyAuth.js";
import { apiKeyRateLimit } from "./rateLimit.js";
import { meter } from "./meter.js";

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

/**
 * The API-key gate for EVERY `/v1/*` route, no exceptions: authenticate,
 * apply the per-minute rate limit, then x402-meter. Mount this FIRST on
 * `/v1/*`, before any `/v1/*` router.
 *
 * There used to be an explicit `PUBLIC_V1_PATHS` bypass list here (SIWS,
 * users/me, the username/slug availability checks, the business-provisioning
 * claim link). It traced back to a 2026-06-30 bug fix — those routers were
 * mounted before the global auth middleware existed and had accidentally
 * had zero gating — that fix centralized the gating but relabeled the
 * accidental gap as an "intentional" exemption instead of closing it.
 * Verified 2026-08-05 that every one of those paths was already receiving
 * the caller's `x-api-key` regardless (the SDK's `ApiClient` attaches it
 * unconditionally to every request, and both first-party BFF proxies —
 * io and the dapp — forward it on every `/v1/*` call). So the exemption
 * bought nothing: real callers already had a key, it just wasn't being
 * checked or metered. Closed for good — no route may skip this gate. Any
 * route-specific auth on top (Clerk JWT, SIWS signature, a claim token)
 * still runs inside its own handler, unchanged; this only decides whether
 * the caller is an accounted-for, credited app or key.
 *
 * `/health` and the x402 pricing-discovery routes (`/.well-known/x402`,
 * `/v1/pricing`) are NOT exceptions to this rule — they're simply mounted
 * in server.ts *before* this middleware runs at all, for different reasons:
 * `/health` has no caller identity to gate (infra healthchecks, not an
 * app), and pricing discovery is the on-ramp INTO the credit system for
 * unfunded external x402 agents, not a way to use the product without one.
 */
export const apiKeyGate: MiddlewareHandler<AppEnv> = composeMiddleware([apiKeyAuth, apiKeyRateLimit(), meter()]);
