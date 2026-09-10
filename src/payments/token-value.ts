import { SUPPORTED_TOKENS } from "@medialane/sdk";
import { normalizeAddress } from "../utils/starknet.js";

export interface ValuedToken {
  symbol: string;
  address: string;
  decimals: number;
}

export function acceptedTokens(): ValuedToken[] {
  return SUPPORTED_TOKENS.map((t) => ({
    symbol: t.symbol,
    address: t.address,
    decimals: t.decimals,
  }));
}

export function tokenByAddress(address: string): ValuedToken | undefined {
  let target: bigint | null = null;
  try {
    target = BigInt(normalizeAddress("STARKNET", address));
  } catch {
    return undefined;
  }
  return acceptedTokens().find((t) => {
    try {
      return BigInt(t.address) === target;
    } catch {
      return false;
    }
  });
}

export function usdcEquivalentAtomic(
  amountAtomic: bigint,
  decimals: number,
  priceUsd: number,
): bigint | null {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  if (amountAtomic < 0n) return null;
  const priceMicros = BigInt(Math.round(priceUsd * 1_000_000));
  return (amountAtomic * priceMicros) / 10n ** BigInt(decimals);
}
