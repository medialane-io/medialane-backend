import { Hono } from "hono";
import type { AppEnv } from "../../types/hono.js";
import type { Chain } from "@prisma/client";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { syncWalletActivityProd } from "../../walletActivity/sync.js";

export interface WalletActivityDeps {
  sync: (chain: Chain, accountAddress: string) => Promise<void>;
  listActivity: (chain: Chain, accountAddress: string) => Promise<unknown[]>;
}

// identityAuth is applied at mount time (server.ts), not inline here — this
// route only ever depends on `c.get("walletAddress")` already being set by
// whatever wraps it, same separation as apiKeyGate's own mounting.
export function createWalletActivityRoutes(deps: WalletActivityDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const addressParam = c.req.query("address");
    if (!addressParam) return c.json({ error: "address is required" }, 400);
    const chain = (c.req.query("chain") as Chain | undefined) ?? "STARKNET";
    const address = normalizeAddress(chain, addressParam);

    const jwtWallet = c.get("walletAddress") as string;
    if (jwtWallet !== address) return c.json({ error: "Wallet address does not match authenticated session" }, 403);

    await deps.sync(chain, address);
    const rows = await deps.listActivity(chain, address);
    return c.json({ data: rows });
  });

  return app;
}

const productionDeps: WalletActivityDeps = {
  sync: syncWalletActivityProd,
  listActivity: (chain, accountAddress) =>
    prisma.walletActivity.findMany({ where: { chain, accountAddress }, orderBy: { timestamp: "desc" } }),
};

export const walletActivityRoutes = createWalletActivityRoutes(productionDeps);
