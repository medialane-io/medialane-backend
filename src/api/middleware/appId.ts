import type { MiddlewareHandler } from "hono";
import prisma from "../../db/client.js";
import type { AppEnv } from "../../types/hono.js";
import { DEFAULT_APP } from "../../utils/caller.js";
import { appSecretMatches } from "../../utils/appSecret.js";
const CACHE_MS = 60_000;

export interface AppIdDeps {
  app(id: string): Promise<{ secretHashes: string[] } | null>;
  now?: () => number;
}

export function createAppId(deps: AppIdDeps): MiddlewareHandler<AppEnv> {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { secretHashes: string[]; at: number }>();

  async function lookup(id: string) {
    const hit = cache.get(id);
    if (hit && now() - hit.at < CACHE_MS) return hit;
    const rec = await deps.app(id);
    if (!rec) return null;
    const entry = { secretHashes: rec.secretHashes, at: now() };
    cache.set(id, entry);
    return entry;
  }

  return async function appId(c, next) {
    const id = c.req.header("x-app-id")?.trim();
    if (!id) {
      c.set("appId", DEFAULT_APP);
      return next();
    }
    const rec = await lookup(id);
    if (!rec) return c.json({ error: "unknown_app", message: "This app is not known." }, 400);
    if (!appSecretMatches(c.req.header("x-app-secret"), rec.secretHashes)) {
      return c.json({ error: "invalid_app_credentials", message: "This app's credentials are not valid." }, 400);
    }
    c.set("appId", id);
    return next();
  };
}

export const appId = createAppId({
  app: (id) => prisma.app.findUnique({ where: { id }, select: { secretHashes: true } }),
});
