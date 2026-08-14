import { normalizeAddress } from "../utils/starknet.js";
import { env } from "../config/env.js";

export async function isAdmin(address: string): Promise<boolean> {
  const raw = env.STARKNET_ADMIN_ADDRESSES;
  if (!raw) return false;
  const want = normalizeAddress("STARKNET", address);
  const allow = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => normalizeAddress("STARKNET", a));
  return allow.includes(want);
}
