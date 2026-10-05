import type { MiddlewareHandler } from "hono";
import prisma from "../../db/client.js";
import type { AppEnv } from "../../types/hono.js";
import { DEFAULT_APP } from "../../utils/caller.js";

export interface AppIdDeps {
  exists(id: string): Promise<boolean>;
}

export function createAppId(deps: AppIdDeps): MiddlewareHandler<AppEnv> {
  const known = new Set<string>([DEFAULT_APP]);
  return async function appId(c, next) {
    const id = c.req.header("x-app-id")?.trim();
    if (!id) {
      c.set("appId", DEFAULT_APP);
      return next();
    }
    if (!known.has(id)) {
      if (!(await deps.exists(id))) return c.json({ error: "unknown_app", message: "This app is not known." }, 400);
      known.add(id);
    }
    c.set("appId", id);
    return next();
  };
}

export const appId = createAppId({
  exists: async (id) => (await prisma.app.findUnique({ where: { id }, select: { id: true } })) !== null,
});
