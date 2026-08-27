import type { MiddlewareHandler } from "hono";
import type { AppSource } from "@prisma/client";
import type { AppEnv } from "../../types/hono.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:appScope");

/**
 * Route groups that only some apps may reach, and who may reach them.
 *
 * This exists because an API key is a bearer token for everything its
 * apiClient can do. Without it, a key issued to a public consumer app is
 * enough to read that tenant's own admin surface — which is exactly what a
 * wildcard in one app's proxy allowlist exposed. The app-side allowlists are
 * still there, but they are now defence in depth rather than the only control.
 *
 * Deliberately a short denylist, not a per-route capability matrix: every
 * other /v1 route is public or self-scoped by its own auth, and a big matrix
 * would rot. Add a group here only when it exposes tenant-administrative data.
 */
const RESTRICTED_PREFIXES: ReadonlyArray<{ prefix: string; allow: ReadonlyArray<AppSource> }> = [
  { prefix: "/v1/portal", allow: ["MEDIALANE_PORTAL"] },
  { prefix: "/v1/business/provisioning", allow: ["MEDIALANE_PORTAL"] },
];

export function restrictionFor(path: string): { prefix: string; allow: ReadonlyArray<AppSource> } | null {
  return (
    RESTRICTED_PREFIXES.find((r) => path === r.prefix || path.startsWith(r.prefix + "/")) ?? null
  );
}

export function isAppSourceAllowed(appSource: AppSource | null | undefined, path: string): boolean {
  const restriction = restrictionFor(path);
  if (!restriction) return true;

  // Legacy keys predate the column. They are server-side keys (portal,
  // media-wallet) rather than keys shipped to a public app proxy, so they are
  // allowed through and logged. Backfill their appSource, then this branch
  // stops being reachable and can be deleted.
  if (!appSource) return true;

  return restriction.allow.includes(appSource);
}

export const appScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apiKey = c.get("apiKey");
  const path = c.req.path;
  const restriction = restrictionFor(path);

  if (restriction && apiKey && !apiKey.appSource) {
    log.warn(
      { keyId: apiKey.id, path },
      "unscoped legacy API key reached a restricted route — backfill its appSource",
    );
  }

  if (!isAppSourceAllowed(apiKey?.appSource, path)) {
    log.warn(
      { keyId: apiKey?.id, appSource: apiKey?.appSource, path },
      "API key blocked from a route outside its app scope",
    );
    return c.json({ error: "This API key is not scoped for that resource" }, 403);
  }

  await next();
};
