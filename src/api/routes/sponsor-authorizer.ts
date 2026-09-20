import { normalizeAddress } from "@medialane/sdk";
import type { Prisma, PrismaClient } from "@prisma/client";
import { verifyAccountSessionToken } from "../../utils/accountSessionToken.js";
import { defaultStore, type RateLimitStore } from "../middleware/rateLimit.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("routes:sponsor-authorizer");

type Db = PrismaClient | Prisma.TransactionClient;

export const SPONSORED_REQUESTS_PER_MINUTE = 60;

export interface SponsorRequest {
  sessionToken?: string;
  apiKeyAccountId?: string;
  userAddress?: string;
}

export interface SponsorDenial {
  status: 401 | 403 | 429;
  error: string;
  code: "not_authorized" | "rate_limited";
}

export interface SponsorAuthorizer {
  authorize(request: SponsorRequest): Promise<SponsorDenial | null>;
}

const NOT_SIGNED_IN: SponsorDenial = { status: 401, error: "Sign in to use sponsored transactions", code: "not_authorized" };
const NOT_YOUR_WALLET: SponsorDenial = { status: 403, error: "This wallet does not belong to the signed-in account", code: "not_authorized" };
const TOO_MANY: SponsorDenial = { status: 429, error: "Too many sponsored transactions. Try again in a minute.", code: "rate_limited" };

export function createSponsorAuthorizer(
  db: Db,
  deps: { verifySession?: (raw: string) => string | null; store?: RateLimitStore } = {},
): SponsorAuthorizer {
  const verifySession = deps.verifySession ?? verifyAccountSessionToken;
  const store = deps.store ?? defaultStore;
  return {
    async authorize({ sessionToken, apiKeyAccountId, userAddress }) {
      const accountId = sessionToken ? verifySession(sessionToken) : (apiKeyAccountId ?? null);
      if (!accountId) return NOT_SIGNED_IN;

      if (userAddress !== undefined) {
        let address: string;
        try {
          address = normalizeAddress("STARKNET", userAddress);
        } catch {
          log.warn({ userAddress, signedInAccount: accountId }, "sponsored gas refused: the wallet address is unreadable");
          return NOT_YOUR_WALLET;
        }
        const identity = await db.identity.findUnique({
          where: { chain_address: { chain: "STARKNET", address } },
          select: { accountId: true },
        });
        if (identity?.accountId !== accountId) {
          log.warn(
            {
              address,
              signedInAccount: accountId,
              walletAccount: identity?.accountId ?? null,
              via: sessionToken ? "session" : "apiKey",
            },
            identity ? "sponsored gas refused: the wallet belongs to another account" : "sponsored gas refused: the wallet is linked to no account",
          );
          return NOT_YOUR_WALLET;
        }
      }

      const { count } = await store.increment(`sponsor:${accountId}`, 60_000);
      if (count > SPONSORED_REQUESTS_PER_MINUTE) return TOO_MANY;
      return null;
    },
  };
}
