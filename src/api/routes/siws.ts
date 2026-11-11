import { Hono } from "hono";
import { validated } from "../http/validate.js";
import { z } from "zod";
import { randomBytes } from "crypto";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { issueToken } from "../../utils/siwsToken.js";
import { issueAccountSessionToken } from "../../utils/accountSessionToken.js";
import { buildTypedData, consumeSiwsProof } from "../../auth/siwsProof.js";
import { ensureAccountForWallet } from "../../utils/account.js";
import { callerApp } from "../../utils/caller.js";
import type { AppEnv } from "../../types/hono.js";
import { chainScope } from "../http/chain.js";

const siws = new Hono<AppEnv>();

const NONCE_TTL_MS = 5 * 60 * 1000;

siws.post(
  "/nonce",
  validated("json", z.object({ walletAddress: z.string().min(1) })),
  chainScope(),
  async (c) => {
  const chain = c.get("chain");

    const { walletAddress } = c.req.valid("json");
    const wallet = normalizeAddress(chain, walletAddress);
    const nonce = randomBytes(15).toString("hex");
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

    await prisma.siwsNonce.create({ data: { walletAddress: wallet, nonce, expiresAt } });

    return c.json({ nonce, typedData: buildTypedData(wallet, nonce) });
  }
);

siws.post(
  "/verify",
  validated("json", z.object({
    walletAddress: z.string().min(1),
    nonce:         z.string().min(1),
    signature:     z.array(z.string()).min(1),
    appSource:     z.string().optional(),
  })),
  chainScope(),
  async (c) => {
  const chain = c.get("chain");

    const { walletAddress, nonce, signature, appSource } = c.req.valid("json");
    const wallet = normalizeAddress(chain, walletAddress);

    const proof = await consumeSiwsProof({ chain, wallet, nonce, signature });
    if (!proof.ok) return c.json(proof.body, proof.status);

    const token = issueToken(chain, wallet);
    if (!appSource) return c.json({ token });

    const { accountId } = await ensureAccountForWallet({
      chain,
      address: wallet,
      appId: callerApp(c),
    });

    return c.json({
      token,
      accountId,
      accountToken: issueAccountSessionToken(accountId),
    });
  }
);

export default siws;
