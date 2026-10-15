import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { sessionVerdict, verifyAccountSessionToken } from "../../utils/accountSessionToken.js";
import { ensureApiCredits } from "../../utils/account.js";

/** Portal routes act for the account of the forwarded session, and only that. */
export const portalSubject: MiddlewareHandler<AppEnv> = async (c, next) => {
  const raw = c.req.header("x-account-session");
  if (!raw) return c.json({ error: "Sign in to use the portal" }, 401);

  const accountId = verifyAccountSessionToken(raw);
  if (!accountId) return c.json({ error: "Invalid or expired session" }, 401);

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, status: true, apiCredits: { select: { id: true, accountId: true, creditBalance: true } } },
  });
  if (!account) return c.json({ error: "No account for this session" }, 404);
  if (sessionVerdict(account) === "inactive") return c.json({ error: "Account is not active" }, 403);

  c.set("account", { id: account.id, status: account.status });
  c.set("apiCredits", account.apiCredits ?? (await ensureApiCredits(account.id)));
  return next();
};
