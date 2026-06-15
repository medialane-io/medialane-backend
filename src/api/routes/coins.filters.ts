// Import the normalizer from the SDK (single source; same one utils/starknet
// re-exports) so this pure helper does NOT pull in config/env at import time —
// keeps it unit-testable without the full backend env (the starknet.test.ts convention).
import { normalizeAddress } from "@medialane/sdk";

/** Where-clause for the PUBLIC coin list (GET /v1/coins). Hides hidden coins. */
export function buildCoinListWhere(opts: { service?: string; creator?: string }) {
  return {
    chain: "STARKNET" as const,
    isHidden: false,
    ...(opts.service ? { service: opts.service } : {}),
    ...(opts.creator ? { creator: normalizeAddress("STARKNET", opts.creator) } : {}),
  };
}

/** Where-clause for the ADMIN coin list (GET /admin/coins). Includes hidden;
 *  search matches name/symbol (insensitive) + full address (only when hex). */
export function buildAdminCoinWhere(opts: { service?: string; search?: string }) {
  const where: Record<string, unknown> = { chain: "STARKNET" };
  if (opts.service) where.service = opts.service;
  if (opts.search) {
    const looksHex = /^0x[0-9a-fA-F]+$/.test(opts.search);
    where.OR = [
      { name: { contains: opts.search, mode: "insensitive" } },
      { symbol: { contains: opts.search, mode: "insensitive" } },
      ...(looksHex ? [{ contractAddress: normalizeAddress("STARKNET", opts.search) }] : []),
    ];
  }
  return where;
}
