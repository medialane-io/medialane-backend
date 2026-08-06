import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { computeAccountAddress } from "@medialane/sdk/starknet";
import { createProvider } from "../../utils/starknet.js";
import { deployWalletViaRelayer } from "../../lib/wallet-relayer.js";
import type { AppEnv } from "../../types/hono.js";

export interface WalletRouteDeps {
  computeAddress: (ownerPubkey: string, salt: string) => string;
  isDeployed: (address: string) => Promise<boolean>;
  deploy: (ownerPubkey: string, salt: string) => Promise<{ address: string; transactionHash: string }>;
}

const deployBodySchema = z.object({
  ownerPubkey: z.string().min(1),
  salt: z.string().optional(),
});

export function createWalletRoutes(deps: WalletRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/deploy", zValidator("json", deployBodySchema), async (c) => {
    const { ownerPubkey, salt = "0x0" } = c.req.valid("json");
    const address = deps.computeAddress(ownerPubkey, salt);

    if (await deps.isDeployed(address)) {
      return c.json({ data: { address, alreadyDeployed: true } });
    }

    const result = await deps.deploy(ownerPubkey, salt);
    return c.json({ data: { address: result.address, alreadyDeployed: false } });
  });

  return app;
}

const productionDeps: WalletRouteDeps = {
  computeAddress: (ownerPubkey, salt) => computeAccountAddress(ownerPubkey, salt),
  isDeployed: async (address) => {
    try {
      await createProvider().getClassHashAt(address);
      return true;
    } catch {
      return false;
    }
  },
  deploy: (ownerPubkey, salt) => deployWalletViaRelayer(ownerPubkey, salt),
};

export const walletRoutes = createWalletRoutes(productionDeps);
