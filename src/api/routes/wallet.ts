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
  /** Injectable for tests — real deploys use a real delay. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A single isDeployed() re-check right after an "already deployed" error
 * isn't reliable — the same RPC-propagation lag that made the pre-deploy
 * check say false can still be present moments later. Retries with delay,
 * same shape as auth/verify.ts's verifyStarknetWithRetry.
 */
async function verifyDeployedWithRetry(
  isDeployed: (address: string) => Promise<boolean>,
  address: string,
  sleep: (ms: number) => Promise<void>,
  retries = 3,
  delayMs = 1500,
): Promise<boolean> {
  for (let i = 0; i <= retries; i++) {
    if (await isDeployed(address)) return true;
    if (i < retries) await sleep(delayMs);
  }
  return false;
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
      // check — and the network then rejects the deploy with this exact
      // message. But the message alone isn't proof: a single flaky RPC
      // provider's fee-estimation step can ALSO throw this same message
      // for an address that was never actually deployed (reproduced live
      // 2026-08-07 — Alchemy, no transaction ever submitted per the
      // relayer's own nonce). Re-verify via the same reliable,
      // multi-provider isDeployed() check before trusting it; only an
      // address the network agrees is genuinely there recovers as
      // success.
      const msg = err instanceof Error ? err.message : String(err);
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      if (
        msg.toLowerCase().includes("contract already deployed") &&
        (await verifyDeployedWithRetry(deps.isDeployed, address, sleep))
      ) {
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
