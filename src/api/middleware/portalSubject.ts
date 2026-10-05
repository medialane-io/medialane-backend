import type { MiddlewareHandler } from "hono";
import { normalizeAddress } from "@medialane/sdk";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { tokenIssuedAt, verifyToken } from "../../utils/siwsToken.js";
import { accountSessionIssuedAt, sessionVerdict, verifyAccountSessionToken } from "../../utils/accountSessionToken.js";
import { ensureAccountForWallet, ensureApiCredits } from "../../utils/account.js";
import { callerApp } from "../../utils/caller.js";

const accountSelect = {
  id: true,
  status: true,
  sessionsValidFrom: true,
  apiCredits: { select: { id: true, accountId: true, plan: true, creditBalance: true } },
} as const;

export const portalSubject: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Sign in to use the portal" }, 401);
  }
  const raw = header.slice(7);

  const accountId = verifyAccountSessionToken(raw);
  if (accountId) {
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: accountSelect });
    if (!account) return c.json({ error: "No account for this session" }, 404);
    const verdict = sessionVerdict(account, raw);
    if (verdict === "inactive") return c.json({ error: "Account is not active" }, 403);
    if (verdict === "expired") return c.json({ error: "Invalid or expired token" }, 401);

    c.set("subjectTokenIssuedAt", accountSessionIssuedAt(raw) ?? undefined);
    c.set("account", { id: account.id, status: account.status });
    c.set("apiCredits", account.apiCredits ?? (await ensureApiCredits(account.id)));
    return next();
  }

  const identity = verifyToken(raw);
  if (!identity) return c.json({ error: "Invalid or expired token" }, 401);

  const address = normalizeAddress(identity.chain, identity.address);
  const appId = callerApp(c);
  const keyAccountId = c.get("apiKey")?.apiCredits?.accountId;
  let wallet = keyAccountId
    ? await prisma.identity.findFirst({
        where: { accountId: keyAccountId, chain: identity.chain, address },
        select: { account: { select: accountSelect } },
      })
    : null;

  if (!wallet) {
    wallet = await prisma.identity.findUnique({
      where: { appId_chain_address: { appId, chain: identity.chain, address } },
      select: { account: { select: accountSelect } },
    });
  }

  if (!wallet) {
    await ensureAccountForWallet({ chain: identity.chain, address, appId });
    wallet = await prisma.identity.findUnique({
      where: { appId_chain_address: { appId, chain: identity.chain, address } },
      select: { account: { select: accountSelect } },
    });
  }

  if (!wallet) return c.json({ error: "No account for this wallet" }, 404);
  if (wallet.account.status === "INACTIVE") return c.json({ error: "Account is not active" }, 403);
  const apiCredits = wallet.account.apiCredits ?? (await ensureApiCredits(wallet.account.id));

  c.set("walletAddress", address);
  c.set("subjectTokenIssuedAt", tokenIssuedAt(raw) ?? undefined);
  c.set("account", { id: wallet.account.id, status: wallet.account.status });
  c.set("apiCredits", apiCredits);
  return next();
};
