import { Hono } from "hono";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:drop");

const drop = new Hono<AppEnv>();

// GET /v1/drop/mint-status/:collection/:wallet
// Returns how many tokens the wallet has minted from a drop collection,
// plus the total minted across all wallets.
drop.get("/mint-status/:collection/:wallet", async (c) => {
  const collection = normalizeAddress(c.req.param("collection"));
  const wallet = normalizeAddress(c.req.param("wallet"));

  const [mintedByWallet, totalMinted] = await Promise.all([
    prisma.token.count({
      where: { chain: "STARKNET", contractAddress: collection, owner: wallet },
    }),
    prisma.token.count({
      where: { chain: "STARKNET", contractAddress: collection },
    }),
  ]);

  return c.json({ data: { mintedByWallet, totalMinted } });
});

export default drop;
