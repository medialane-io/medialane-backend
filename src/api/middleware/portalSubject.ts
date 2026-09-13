import type { MiddlewareHandler } from "hono";
import { normalizeAddress } from "@medialane/sdk";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { tokenIssuedAt, verifyToken } from "../../utils/siwsToken.js";
import { accountSessionIssuedAt, verifyAccountSessionToken } from "../../utils/accountSessionToken.js";
import { ensureAccountForWallet } from "../../utils/account.js";
import { requireTenant } from "../../utils/tenant.js";

const accountSelect = {
  id: true,
  status: true,
  apiClient: { select: { id: true, accountId: true, plan: true, creditBalance: true } },
} as const;

export const portalSubject: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return next();
  const raw = header.slice(7);

  const accountId = verifyAccountSessionToken(raw);
  if (accountId) {
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: accountSelect });
    if (!account?.apiClient) return c.json({ error: "No account for this session" }, 404);
    if (account.status !== "ACTIVE") return c.json({ error: "Account is not active" }, 403);

    c.set("subjectTokenIssuedAt", accountSessionIssuedAt(raw) ?? undefined);
    c.set("account", { id: account.id, status: account.status });
    c.set("apiClient", account.apiClient);
    return next();
  }

  const identity = verifyToken(raw);
  if (!identity) return c.json({ error: "Invalid or expired token" }, 401);

  const address = normalizeAddress(identity.chain, identity.address);
  let wallet = await prisma.identity.findUnique({
    where: { chain_address: { chain: identity.chain, address } },
    select: { account: { select: accountSelect } },
  });

  if (!wallet) {
    // The token already proves wallet ownership, so a first-time portal
    // visitor is provisioned here rather than 404ing and relying on a
    // client-side registration call that may never fire before this request.
    const tenantId = await requireTenant("MEDIALANE_PORTAL");
    await ensureAccountForWallet({ chain: identity.chain, address, tenantId });
    wallet = await prisma.identity.findUnique({
      where: { chain_address: { chain: identity.chain, address } },
      select: { account: { select: accountSelect } },
    });
  }

  const apiClient = wallet?.account.apiClient;
  if (!wallet || !apiClient) return c.json({ error: "No account for this wallet" }, 404);
  if (wallet.account.status !== "ACTIVE") return c.json({ error: "Account is not active" }, 403);

  c.set("walletAddress", address);
  c.set("subjectTokenIssuedAt", tokenIssuedAt(raw) ?? undefined);
  c.set("account", { id: wallet.account.id, status: wallet.account.status });
  c.set("apiClient", apiClient);
  return next();
};
