import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { callerClientId } from "../../utils/caller.js";
import { cachedAppNameForClient } from "../../apps/cache.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:appSource");

export interface AppSourceCheckDeps {
  appFor: (clientId: string) => Promise<string | null>;
  warn: (data: Record<string, unknown>, message: string) => void;
}

export function createAppSourceCheck(deps: AppSourceCheckDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const declared = c.req.header("x-app-source")?.trim();
    const clientId = declared ? callerClientId(c) : null;
    if (declared && clientId) {
      try {
        const keyApp = await deps.appFor(clientId);
        if (keyApp !== declared) {
          deps.warn({ declared, keyApp, clientId, path: c.req.path }, "x-app-source does not match the key's app");
        }
      } catch (err) {
        deps.warn({ declared, clientId, err: err instanceof Error ? err.message : String(err) }, "could not check x-app-source");
      }
    }
    await next();
  };
}

export const appSourceCheck = createAppSourceCheck({
  appFor: cachedAppNameForClient(),
  warn: (data, message) => log.warn(data, message),
});
