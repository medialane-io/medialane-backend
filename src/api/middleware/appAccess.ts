import type { MiddlewareHandler } from "hono";
import { isPublicAppRoute } from "@medialane/sdk";
import prisma from "../../db/client.js";
import type { AppEnv } from "../../types/hono.js";
import { callerApp, DEFAULT_APP } from "../../utils/caller.js";
import { sessionVerdict, verifyAccountSessionToken } from "../../utils/accountSessionToken.js";

export interface AppAccessDeps {
  session(raw: string): Promise<"ok" | "inactive" | "invalid">;
}

const SIGN_IN_REQUIRED = { error: "Sign in to continue", code: "sign_in_required" } as const;
const INACTIVE = { error: "Account is not active", code: "account_inactive" } as const;

export function createAppAccess(deps: AppAccessDeps): MiddlewareHandler<AppEnv> {
  return async function appAccess(c, next) {
    if (callerApp(c) === DEFAULT_APP) return next();
    const path = c.req.path.replace(/^\/v1\//, "");
    if (isPublicAppRoute(c.req.method, path)) return next();
    const raw = c.req.header("x-account-session");
    const verdict = raw ? await deps.session(raw) : "invalid";
    if (verdict === "ok") return next();
    if (verdict === "inactive") return c.json(INACTIVE, 403);
    return c.json(SIGN_IN_REQUIRED, 401);
  };
}

export const appAccess = createAppAccess({
  session: async (raw) => {
    const accountId = verifyAccountSessionToken(raw);
    if (!accountId) return "invalid";
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: { status: true } });
    if (!account) return "invalid";
    return sessionVerdict(account) === "inactive" ? "inactive" : "ok";
  },
});
