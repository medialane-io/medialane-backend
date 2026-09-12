import type { MiddlewareHandler } from "hono";
import { normalizeAddress } from "@medialane/sdk";
import type { AppEnv } from "../../types/hono.js";
import prisma from "../../db/client.js";
import { verifyToken } from "../../utils/siwsToken.js";

export const portalSubject: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return next();

  const identity = verifyToken(header.slice(7));
  if (!identity) return c.json({ error: "Invalid or expired SIWS token" }, 401);

  const wallet = await prisma.identity.findUnique({
    where: {
      chain_address: {
        chain: identity.chain,
        address: normalizeAddress(identity.chain, identity.address),
      },
    },
    select: {
      account: {
        select: {
          id: true,
          status: true,
          apiClient: { select: { id: true, accountId: true, plan: true, creditBalance: true } },
        },
      },
    },
  });

  const apiClient = wallet?.account.apiClient;
  if (!wallet || !apiClient) return c.json({ error: "No account for this wallet" }, 404);
  if (wallet.account.status !== "ACTIVE") return c.json({ error: "Account is not active" }, 403);

  c.set("account", { id: wallet.account.id, status: wallet.account.status });
  c.set("apiClient", apiClient);
  return next();
};
