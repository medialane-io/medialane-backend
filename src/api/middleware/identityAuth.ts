import type { Context, Next } from "hono";
import type { Chain } from "@prisma/client";
import prisma from "../../db/client.js";
import { verifyToken as verifySiwsToken } from "../../utils/siwsToken.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { callerClientId } from "../../utils/caller.js";
import type { AppEnv } from "../../types/hono.js";

export interface IdentityAuthDeps {
  isInactive(clientId: string | null, chain: string, address: string): Promise<boolean>;
}

const productionDeps: IdentityAuthDeps = {
  isInactive: async (clientId, chain, address) => {
    if (!clientId) return false;
    const wallet = await prisma.identity.findUnique({
      where: { clientId_chain_address: { clientId, chain: chain as Chain, address: normalizeAddress(chain as Chain, address) } },
      select: { account: { select: { status: true } } },
    });
    return wallet?.account.status === "INACTIVE";
  },
};

export function createIdentityAuth(deps: IdentityAuthDeps) {
  return async function identityAuth(c: Context, next: Next) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const token = authHeader.slice(7);
    const id = verifySiwsToken(token);
    if (!id) return c.json({ error: "Invalid or expired SIWS token" }, 401);

    if (await deps.isInactive(callerClientId(c as unknown as Context<AppEnv>), id.chain, id.address)) {
      return c.json({ error: "Account is not active" }, 403);
    }

    c.set("walletAddress", id.address);
    return next();
  };
}

export const identityAuth = createIdentityAuth(productionDeps);
