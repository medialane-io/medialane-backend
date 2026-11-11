import type { Chain } from "@prisma/client";
import prisma from "../db/client.js";
import { verifyWalletSignature } from "./verify.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("auth:siws");

export function buildTypedData(wallet: string, nonce: string) {
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
      app: "medialane",
    },
  };
}

export type SiwsProofResult =
  | { ok: true }
  | { ok: false; status: 400 | 401; body: { error: string; message?: string } };

export async function consumeSiwsProof(params: {
  chain: Chain;
  wallet: string;
  nonce: string;
  signature: string[];
}, verify: typeof verifyWalletSignature = verifyWalletSignature): Promise<SiwsProofResult> {
  const { chain, wallet, nonce, signature } = params;

  const record = await prisma.siwsNonce.findUnique({ where: { nonce } });
  if (!record || record.expiresAt < new Date()) {
    if (record) await prisma.siwsNonce.delete({ where: { nonce } });
    return { ok: false, status: 400, body: { error: "nonce_expired" } };
  }
  if (record.walletAddress !== wallet) {
    return { ok: false, status: 400, body: { error: "wallet_mismatch" } };
  }

  let result;
  try {
    result = await verify({ chain, address: wallet, typedData: buildTypedData(wallet, nonce), signature });
  } catch (err) {
    log.error({ err, wallet, sigLength: signature.length }, "SIWS verify: signature verification threw");
    return { ok: false, status: 401, body: { error: "invalid_signature" } };
  }

  if (!result.ok) {
    if (result.reason === "not_deployed") {
      log.warn({ wallet }, "SIWS verify: wallet contract not deployed (counterfactual account)");
      return {
        ok: false,
        status: 400,
        body: { error: "account_not_deployed", message: "Check if your wallet is deployed on Starknet." },
      };
    }
    log.warn({ wallet }, "SIWS verify: on-chain is_valid_signature returned false");
    return { ok: false, status: 401, body: { error: "invalid_signature" } };
  }

  const { count } = await prisma.siwsNonce.deleteMany({ where: { nonce } });
  if (count === 0) return { ok: false, status: 400, body: { error: "nonce_expired" } };
  return { ok: true };
}
