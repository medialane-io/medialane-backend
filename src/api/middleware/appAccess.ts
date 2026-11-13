import type { MiddlewareHandler } from "hono";
import { isPublicAppRoute } from "@medialane/sdk";
import type { AppEnv } from "../../types/hono.js";
import { callerApp, DEFAULT_APP } from "../../utils/caller.js";
import { readSession } from "../../utils/accountSession.js";
import { ACCOUNT_INACTIVE, SIGN_IN_REQUIRED } from "./sessionRefusal.js";

export interface AppAccessDeps {
  session(raw: string): Promise<"ok" | "inactive" | "invalid">;
}


export function createAppAccess(deps: AppAccessDeps): MiddlewareHandler<AppEnv> {
  return async function appAccess(c, next) {
    if (callerApp(c) === DEFAULT_APP) return next();
    const path = c.req.path.replace(/^\/(v1\/)?/, "");
    if (isPublicAppRoute(c.req.method, path)) return next();
    const raw = c.req.header("x-account-session");
    const verdict = raw ? await deps.session(raw) : "invalid";
    if (verdict === "ok") return next();
    if (verdict === "inactive") return c.json(ACCOUNT_INACTIVE, 403);
    return c.json(SIGN_IN_REQUIRED, 401);
  };
}

export const appAccess = createAppAccess({
  session: async (raw) => (await readSession(raw)).verdict,
});
