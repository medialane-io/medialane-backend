import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { currentAccountIdFromSession } from "../../utils/accountSession.js";
import { verifyToken } from "../../utils/siwsToken.js";

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const forwarded = c.req.header("x-account-session");
  if (forwarded && (await currentAccountIdFromSession(forwarded))) return next();

  const authorization = c.req.header("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const raw = authorization.slice(7);
    if (verifyToken(raw) || (await currentAccountIdFromSession(raw))) return next();
  }

  return c.json({ error: "Sign in to use gas sponsorship", code: "invalid_request_auth" }, 401);
};
