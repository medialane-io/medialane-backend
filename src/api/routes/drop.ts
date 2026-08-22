import { Hono } from "hono";
import { publicCache } from "../middleware/publicCache.js";
import prisma from "../../db/client.js";
import { parseSingleChain } from "../utils/chainFilter.js";
import { normalizeAddress } from "../../utils/starknet.js";
import type { AppEnv } from "../../types/hono.js";


const drop = new Hono<AppEnv>();

drop.get("/mint-status/:collection/:wallet", async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const collection = normalizeAddress(chain, c.req.param("collection"));
  const wallet = normalizeAddress(chain, c.req.param("wallet"));

  const [mintedByWallet, totalMinted] = await Promise.all([
    prisma.tokenBalance.count({
      where: { chain, contractAddress: collection, owner: wallet, amount: { not: "0" } },
    }),
    prisma.token.count({
      where: { chain, contractAddress: collection },
    }),
  ]);

  return c.json({ data: { mintedByWallet, totalMinted } });
});

drop.get("/:contract/info", publicCache(30), async (c) => {
  const chain = parseSingleChain(c.req.query("chain"));
  if (!chain) return c.json({ error: "Invalid chain" }, 400);
  const contractAddress = normalizeAddress(chain, c.req.param("contract"));

  const collection = await prisma.collection.findUnique({
    where: { chain_contractAddress: { chain, contractAddress } },
  });

  if (!collection) {
    return c.json({ error: "Drop not found" }, 404);
  }

  return c.json({
    data: {
      contractAddress: collection.contractAddress,
      name: collection.name,
      symbol: collection.symbol,
      description: collection.description,
      image: collection.image,
      owner: collection.owner,
      totalMinted: collection.totalSupply,
    },
  });
});

export default drop;
