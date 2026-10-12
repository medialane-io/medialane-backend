import { Hono } from "hono";
import type { ProviderInterface } from "starknet";
import { getCreatorCoinGuarantees, popClaimInfo, readDrop } from "@medialane/sdk/starknet";
import { createProvider, normalizeAddress } from "../../utils/starknet.js";
import type { AppEnv } from "../../types/hono.js";

export function createChainReadRoutes(provider: () => ProviderInterface = () => createProvider() as never): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/coins/:contract/guarantees", async (c) => {
    const contract = normalizeAddress("STARKNET", c.req.param("contract"));
    try {
      return c.json({ data: await getCreatorCoinGuarantees(contract, provider()) });
    } catch {
      return c.json({ data: null });
    }
  });

  app.get("/pop/:collection/claim-info", async (c) => {
    const collection = normalizeAddress("STARKNET", c.req.param("collection"));
    try {
      return c.json({ data: await popClaimInfo(provider(), collection) });
    } catch {
      return c.json({ data: null });
    }
  });

  app.get("/drops/:contract/state", async (c) => {
    const contract = normalizeAddress("STARKNET", c.req.param("contract"));
    try {
      const drop = await readDrop(provider(), contract);
      return c.json({
        data: {
          ...drop,
          price: drop.price.toString(),
          maxPerWallet: drop.maxPerWallet.toString(),
          maxSupply: drop.maxSupply.toString(),
          totalMinted: drop.totalMinted.toString(),
        },
      });
    } catch {
      return c.json({ data: null });
    }
  });

  return app;
}

export default createChainReadRoutes();
