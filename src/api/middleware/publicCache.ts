import type { MiddlewareHandler } from "hono";

/**
 * Marks a read route's successful GET responses as publicly cacheable for
 * `seconds`. The indexer is an eventually-consistent projection (mirror ticks
 * every ~10s), so a briefly-stale list/stat response is indistinguishable from
 * a live one — short TTLs here cut repeated recomputation and client refetch
 * without any invalidation machinery.
 *
 * Only for tenant-independent reads: the response body must not vary by API
 * key or caller. Never mount on mutating routes or anything caller-scoped
 * (portal, intents, gated content, /users/me).
 */
export function publicCache(seconds: number): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.method === "GET" && c.res.status === 200) {
      c.res.headers.set("Cache-Control", `public, max-age=${seconds}`);
    }
  };
}
