import type { MiddlewareHandler } from "hono";
import { normalizeAddress } from "@medialane/sdk";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { tokenIssuedAt, verifyToken } from "../../utils/siwsToken.js";
import { accountSessionIssuedAt, verifyAccountSessionToken } from "../../utils/accountSessionToken.js";
import { ensureAccountForWallet } from "../../utils/account.js";
import { callerClientId } from "../../utils/caller.js";

const accountSelect = {
  id: true,
  status: true,
  apiClient: { select: { id: true, accountId: true, plan: true, creditBalance: true } },
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
    if (!account?.apiClient) return c.json({ error: "No account for this session" }, 404);
    if (account.status === "INACTIVE") return c.json({ error: "Account is not active" }, 403);

    c.set("subjectTokenIssuedAt", accountSessionIssuedAt(raw) ?? undefined);
    c.set("account", { id: account.id, status: account.status });
    c.set("apiClient", account.apiClient);
    return next();
  }

  const identity = verifyToken(raw);
  if (!identity) return c.json({ error: "Invalid or expired token" }, 401);

  const address = normalizeAddress(identity.chain, identity.address);
  const clientId = callerClientId(c);
  if (!clientId) return c.json({ error: "This API key has no client" }, 400);
  let wallet = await prisma.identity.findUnique({
    where: { clientId_chain_address: { clientId, chain: identity.chain, address } },
    select: { account: { select: accountSelect } },
  });

  if (!wallet || !wallet.account.apiClient) {
    await ensureAccountForWallet({ chain: identity.chain, address, clientId });
    wallet = await prisma.identity.findUnique({
      where: { clientId_chain_address: { clientId, chain: identity.chain, address } },
      select: { account: { select: accountSelect } },
    });
  }

  const apiClient = wallet?.account.apiClient;
  if (!wallet || !apiClient) return c.json({ error: "No account for this wallet" }, 404);
  if (wallet.account.status === "INACTIVE") return c.json({ error: "Account is not active" }, 403);

  c.set("walletAddress", address);
  c.set("subjectTokenIssuedAt", tokenIssuedAt(raw) ?? undefined);
  c.set("account", { id: wallet.account.id, status: wallet.account.status });
  c.set("apiClient", apiClient);
  return next();
};
