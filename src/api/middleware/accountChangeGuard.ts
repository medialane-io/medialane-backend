import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { currentSession, type CurrentSession } from "../../utils/accountSession.js";
import {
  productionSessionFreshnessDeps,
  sessionPredatesVerification,
  type SessionFreshnessDeps,
} from "../http/sessionFreshness.js";

/**
 * Routes that change who controls an account or its wallet. An account session issued before the account's email
 * was verified cannot use them. Add new account-changing routes here; a test checks every entry exists in the app.
 */
export const ACCOUNT_CHANGE_ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  ["POST", "/v1/users/me"],
  ["POST", "/v1/users/me/generate-wallet"],
  ["POST", "/v1/users/me/wallet/key"],
  ["POST", "/v1/users/me/wallet/recovery"],
  ["POST", "/v1/users/me/wallet/recovery/complete"],
  ["POST", "/v1/users/me/email"],
  ["POST", "/v1/users/me/sign-out-other-devices"],
  ["POST", "/v1/paymaster/deploy/execute"],
];

const ACCOUNT_SESSION_PREFIX = "account_session_";
const SIGN_IN_AGAIN = { error: "Sign in again to make this change", code: "sign_in_again" } as const;

export interface AccountChangeGuardDeps {
  session(raw: string): Promise<CurrentSession | null>;
  freshness: SessionFreshnessDeps;
}

export function createAccountChangeGuard(
  deps: AccountChangeGuardDeps,
  routes: ReadonlyArray<readonly [string, string]> = ACCOUNT_CHANGE_ROUTES,
): MiddlewareHandler<AppEnv> {
  const guarded = new Set(routes.map(([method, path]) => `${method} ${path}`));
  return async function accountChangeGuard(c, next) {
    const path = c.req.path.length > 1 ? c.req.path.replace(/\/+$/, "") : c.req.path;
    if (!guarded.has(`${c.req.method} ${path}`)) return next();

    const bearer = c.req.header("authorization")?.startsWith("Bearer ") ? c.req.header("authorization")!.slice(7) : null;
    const raw = c.req.header("x-account-session") ?? (bearer?.startsWith(ACCOUNT_SESSION_PREFIX) ? bearer : null);
    const session = raw ? await deps.session(raw) : null;
    if (session && (await sessionPredatesVerification(session.accountId, session.issuedAt, deps.freshness))) {
      return c.json(SIGN_IN_AGAIN, 403);
    }
    return next();
  };
}

export const accountChangeGuard = createAccountChangeGuard({
  session: currentSession,
  freshness: productionSessionFreshnessDeps,
});
