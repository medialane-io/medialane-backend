import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomBytes } from "crypto";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { issueToken } from "../../utils/siwsToken.js";
import { verifyWalletSignature } from "../../auth/verify.js";
import { createLogger } from "../../utils/logger.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:siws");

const siws = new Hono<AppEnv>();

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** SNIP-12 typed data for a SIWS login message. */
function buildTypedData(wallet: string, nonce: string) {
  return {
    domain: { name: "Medialane", version: "1", chainId: "SN_MAIN", revision: "1" },
    primaryType: "SiwsMessage",
    types: {
      StarknetDomain: [
        { name: "name",     type: "shortstring" },
        { name: "version",  type: "shortstring" },
        { name: "chainId",  type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      SiwsMessage: [
        { name: "wallet", type: "ContractAddress" },
        { name: "nonce",  type: "shortstring" },
        { name: "app",    type: "shortstring" },
      ],
    },
    message: {
      wallet,
      nonce,
      app: "medialane.io",
    },
  };
}

// POST /v1/auth/siws/nonce
siws.post(
  "/nonce",
  zValidator("json", z.object({ walletAddress: z.string().min(1) })),
  async (c) => {
    const { walletAddress } = c.req.valid("json");
    const wallet = normalizeAddress("STARKNET", walletAddress);
    const nonce = randomBytes(15).toString("hex"); // 30 chars — fits in shortstring
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

    await prisma.siwsNonce.create({ data: { walletAddress: wallet, nonce, expiresAt } });

    return c.json({ nonce, typedData: buildTypedData(wallet, nonce) });
  }
);

// POST /v1/auth/siws/verify
siws.post(
  "/verify",
  zValidator("json", z.object({
    walletAddress: z.string().min(1),
    nonce:         z.string().min(1),
    signature:     z.array(z.string()).min(1),
  })),
  async (c) => {
    const { walletAddress, nonce, signature } = c.req.valid("json");
    const wallet = normalizeAddress("STARKNET", walletAddress);

    const record = await prisma.siwsNonce.findUnique({ where: { nonce } });
    if (!record || record.expiresAt < new Date()) {
      if (record) await prisma.siwsNonce.delete({ where: { nonce } });
      return c.json({ error: "nonce_expired" }, 400);
    }
    if (record.walletAddress !== wallet) {
      return c.json({ error: "wallet_mismatch" }, 400);
    }

    const typedData = buildTypedData(wallet, nonce);

    // SIWS is the Starknet sign-in; verification goes through the chain-dispatch
    // seam (spec §3.4) so a future SIWE/SIWB sibling reuses it unchanged.
    let result;
    try {
      result = await verifyWalletSignature({ chain: "STARKNET", address: wallet, typedData, signature });
    } catch (err) {
      // Unexpected RPC / verification failure — log fully, keep the generic 401.
      log.error(
        { err, wallet, sigLength: signature.length },
        "SIWS verify: signature verification threw",
      );
      return c.json({ error: "invalid_signature" }, 401);
    }

    if (!result.ok) {
      if (result.reason === "not_deployed") {
        // Counterfactual smart wallet — surface a deploy-first hint, not "invalid".
        log.warn({ wallet }, "SIWS verify: wallet contract not deployed (counterfactual account)");
        return c.json({
          error: "account_not_deployed",
          message: "Check if your wallet is deployed on Starknet.",
        }, 400);
      }
      log.warn({ wallet }, "SIWS verify: on-chain is_valid_signature returned false");
      return c.json({ error: "invalid_signature" }, 401);
    }

    // Single-use: delete nonce after successful verification
    await prisma.siwsNonce.delete({ where: { nonce } });

    return c.json({ token: issueToken("STARKNET", wallet) });
  }
);

export default siws;
