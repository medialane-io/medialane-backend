import type { Context, Next } from "hono";
import type { Chain } from "@prisma/client";
import prisma from "../../db/client.js";
import { verifyToken as verifySiwsToken } from "../../utils/siwsToken.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { callerApp } from "../../utils/caller.js";
import { accountWallet } from "../../utils/account.js";
import { sessionVerdict, verifyAccountSessionToken } from "../../utils/accountSessionToken.js";
import type { AppEnv } from "../../types/hono.js";

export type SessionLookup =
  | { verdict: "ok"; accountId: string; walletAddress: string | null }
  | { verdict: "inactive" | "expired" | "invalid" };

export interface IdentityAuthDeps {
  isInactive(appId: string | null, chain: string, address: string): Promise<boolean>;
  session(raw: string): Promise<SessionLookup>;
}

const productionDeps: IdentityAuthDeps = {
  isInactive: async (appId, chain, address) => {
    if (!appId) return false;
    const wallet = await prisma.identity.findUnique({
      where: { appId_chain_address: { appId, chain: chain as Chain, address: normalizeAddress(chain as Chain, address) } },
      select: { account: { select: { status: true } } },
    });
    return wallet?.account.status === "INACTIVE";
  },
  session: async (raw) => {
    const accountId = verifyAccountSessionToken(raw);
    if (!accountId) return { verdict: "invalid" };
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { status: true, sessionsValidFrom: true },
    });
    if (!account) return { verdict: "invalid" };
    const verdict = sessionVerdict(account, raw);
    if (verdict !== "ok") return { verdict };
    return { verdict, accountId, walletAddress: await accountWallet(accountId) };
  },
};

const INACTIVE = { error: "Account is not active", code: "account_inactive" } as const;

export function createIdentityAuth(deps: IdentityAuthDeps, options: { walletOptional?: boolean } = {}) {
  return async function identityAuth(c: Context, next: Next) {
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const id = verifySiwsToken(authHeader.slice(7));
      if (!id) return c.json({ error: "Invalid or expired SIWS token" }, 401);
      if (await deps.isInactive(callerApp(c as unknown as Context<AppEnv>), id.chain, id.address)) {
        return c.json(INACTIVE, 403);
      }
      c.set("walletAddress", id.address);
      return next();
    }

    const sessionToken = c.req.header("x-account-session");
    if (!sessionToken) return c.json({ error: "Authentication required" }, 401);

    const session = await deps.session(sessionToken);
    if (session.verdict === "inactive") return c.json(INACTIVE, 403);
    if (session.verdict !== "ok") return c.json({ error: "Invalid or expired session" }, 401);
    if (!session.walletAddress && !options.walletOptional) {
      return c.json({ error: "This account has no wallet yet", code: "wallet_required" }, 409);
    }

    c.set("sessionAccountId", session.accountId);
    if (session.walletAddress) c.set("walletAddress", session.walletAddress);
    return next();
  };
}

export const identityAuth = createIdentityAuth(productionDeps);
export const identityAuthWalletOptional = createIdentityAuth(productionDeps, { walletOptional: true });
