import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { computeAccountAddress } from "@medialane/sdk/starknet";
import { callRpc } from "../../utils/starknet.js";
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

    try {
      const result = await deps.deploy(ownerPubkey, salt);
      return c.json({ data: { address: result.address, alreadyDeployed: false } });
    } catch (err) {
      // isDeployed() can still say false for a wallet that's genuinely
      // already live — deployed moments ago (e.g. a retried "Try again")
      // but not yet visible to whichever RPC replica just answered the
      // check. When that happens the network itself rejects the deploy
      // with this exact message; that's confirmation of success, not a
      // failure, so recover instead of erroring.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("contract already deployed")) {
        return c.json({ data: { address, alreadyDeployed: true } });
      }
      throw err;
    }
  });

  return app;
}

const productionDeps: WalletRouteDeps = {
  computeAddress: (ownerPubkey, salt) => computeAccountAddress(ownerPubkey, salt),
  isDeployed: async (address) => {
    try {
      await callRpc((provider) => provider.getClassHashAt(address));
      return true;
    } catch {
      return false;
    }
  },
  deploy: (ownerPubkey, salt) => deployWalletViaRelayer(ownerPubkey, salt),
};

export const walletRoutes = createWalletRoutes(productionDeps);
