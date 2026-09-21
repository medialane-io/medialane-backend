import { normalizeAddress } from "@medialane/sdk";
import type { Prisma, PrismaClient } from "@prisma/client";
import { defaultStore, type RateLimitStore } from "../middleware/rateLimit.js";

type Db = PrismaClient | Prisma.TransactionClient;

export const SPONSORED_REQUESTS_PER_MINUTE = 60;

export interface SponsorRequest {
  userAddress?: string;
}

export interface SponsorDenial {
  status: 400 | 429;
  error: string;
  code: "invalid_request" | "rate_limited";
}

export interface SponsorAuthorizer {
  authorize(request: SponsorRequest): Promise<SponsorDenial | null>;
}

const UNREADABLE_WALLET: SponsorDenial = {
  status: 400,
  error: "That wallet address could not be read",
  code: "invalid_request",
};

const TOO_MANY: SponsorDenial = {
  status: 429,
  error: "Too many sponsored transactions. Try again in a minute.",
  code: "rate_limited",
};

export function createSponsorAuthorizer(
  _db: Db,
  deps: { store?: RateLimitStore } = {},
): SponsorAuthorizer {
  const store = deps.store ?? defaultStore;
  return {
    async authorize({ userAddress }) {
      let bucket = "sponsor:deploy";

      if (userAddress !== undefined) {
        try {
          bucket = `sponsor:${normalizeAddress("STARKNET", userAddress)}`;
        } catch {
          return UNREADABLE_WALLET;
        }
      }

      const { count } = await store.increment(bucket, 60_000);
      return count > SPONSORED_REQUESTS_PER_MINUTE ? TOO_MANY : null;
    },
  };
}
