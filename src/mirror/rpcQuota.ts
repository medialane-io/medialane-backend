/**
 * Detect Alchemy / provider monthly cap and HTTP 429 style failures so the mirror
 * can back off instead of hammering the same failing RPC every poll interval.
 */
export function isStarknetRpcQuotaError(err: unknown): boolean {
  if (err == null) return false;
  const e = err as Record<string, unknown>;
  const msg = String(e.message ?? e.toString?.() ?? "");

  // starknet.js RpcError exposes .code from baseError (HTTP 429 from Alchemy)
  if (e.code === 429) return true;

  const base = e.baseError as Record<string, unknown> | undefined;
  if (base && base.code === 429) return true;

  const lower = msg.toLowerCase();
  if (lower.includes("429")) return true;
  if (lower.includes("monthly capacity")) return true;
  if (lower.includes("scaling policy")) return true;
  if (lower.includes("rate limit")) return true;
  if (lower.includes("too many requests")) return true;
  if (lower.includes("quota")) return true;

  return false;
}
