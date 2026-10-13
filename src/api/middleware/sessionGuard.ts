import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types/hono.js";
import { currentAccountIdFromSession } from "../../utils/accountSession.js";
import { verifyToken } from "../../utils/siwsToken.js";
import { accountWallet } from "../../utils/account.js";
import { normalizeAddress } from "../../utils/starknet.js";

export interface SessionGuardDeps {
  accountFromSession(raw: string): Promise<string | null>;
  walletOf(accountId: string): Promise<string | null>;
  siwsIdentity(raw: string): { chain: "STARKNET"; address: string } | null;
}

export const productionSessionGuardDeps: SessionGuardDeps = {
  accountFromSession: currentAccountIdFromSession,
  walletOf: (accountId) => accountWallet(accountId),
  siwsIdentity: (raw) => {
    const id = verifyToken(raw);
    return id && id.chain === "STARKNET" ? { chain: "STARKNET", address: id.address } : null;
  },
};

const REFUSED = { error: "Sign in to use gas sponsorship", code: "invalid_request_auth" } as const;

export function createRequireSession(deps: SessionGuardDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const fromAccount = async (raw: string) => {
      const accountId = await deps.accountFromSession(raw);
      if (!accountId) return false;
      c.set("sessionAccountId", accountId);
      const wallet = await deps.walletOf(accountId);
      if (wallet) c.set("sponsorWallet", normalizeAddress("STARKNET", wallet));
      return true;
    };

    const forwarded = c.req.header("x-account-session");
    if (forwarded && (await fromAccount(forwarded))) return next();

    const authorization = c.req.header("authorization");
    if (authorization?.startsWith("Bearer ")) {
      const raw = authorization.slice(7);
      const identity = deps.siwsIdentity(raw);
      if (identity) {
        c.set("sponsorWallet", normalizeAddress("STARKNET", identity.address));
        return next();
      }
      if (await fromAccount(raw)) return next();
    }

    return c.json(REFUSED, 401);
  };
}

export const requireSession = createRequireSession(productionSessionGuardDeps);
