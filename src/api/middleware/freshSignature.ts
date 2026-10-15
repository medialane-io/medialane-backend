import type { MiddlewareHandler } from "hono";
import type { Chain } from "@prisma/client";
import { normalizeAddress } from "@medialane/sdk";
import prisma from "../../db/client.js";
import type { AppEnv } from "../../types/hono.js";
import { tokenIssuedAt, verifyToken } from "../../utils/siwsToken.js";

export const FRESH_SIGNATURE_SECONDS = 10 * 60;

export interface FreshSignatureDeps {
  ownsWallet(accountId: string, chain: Chain, address: string): Promise<boolean>;
}

/**
 * Requires `x-fresh-signature`: a wallet sign-in token issued in the last few minutes by a wallet
 * of the request's account. The account itself comes from the session or subject set earlier.
 */
export function createFreshSignature(deps: FreshSignatureDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const account = c.get("account");
    const raw = c.req.header("x-fresh-signature");
    const identity = raw ? verifyToken(raw) : null;
    const issuedAt = raw && identity ? tokenIssuedAt(raw) : null;
    const valid =
      account !== undefined &&
      identity !== null &&
      issuedAt !== null &&
      isFresh(issuedAt) &&
      (await deps.ownsWallet(account.id, identity.chain, normalizeAddress(identity.chain, identity.address)));
    if (!valid) {
      return c.json(
        { error: "stale_signature", message: "Confirm with your wallet to do this. A stored sign-in is not enough on its own." },
        401,
      );
    }
    return next();
  };
}

export const freshSignature = createFreshSignature({
  ownsWallet: async (accountId, chain, address) =>
    (await prisma.identity.findFirst({ where: { accountId, chain, address }, select: { id: true } })) !== null,
});

export function isFresh(issuedAt: number, now: number = Math.floor(Date.now() / 1000)): boolean {
  if (issuedAt > now + 60) return false;
  return now - issuedAt <= FRESH_SIGNATURE_SECONDS;
}
