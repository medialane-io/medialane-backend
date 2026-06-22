import { normalizeAddress } from "../utils/starknet.js";
import { env } from "../config/env.js";

/**
 * Is `address` an admin? Off-chain allowlist (ADMIN_ADDRESSES, comma-separated)
 * today; the single seam to later swap for an on-chain role read. Only ever
 * reached AFTER the wallet signature is verified, so the allowlist is unforgeable.
 */
export async function isAdmin(address: string): Promise<boolean> {
  const raw = env.ADMIN_ADDRESSES;
  if (!raw) return false;
  const want = normalizeAddress("STARKNET", address);
  const allow = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => normalizeAddress("STARKNET", a));
  return allow.includes(want);
}
