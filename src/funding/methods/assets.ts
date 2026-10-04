import { acceptedTokens, usdcEquivalentAtomic, type ValuedToken } from "../../payments/token-value.js";
import type { UsdPrices } from "../../utils/usdPrices.js";

export type PriceReader = () => Promise<UsdPrices | null>;

export function acceptedSymbols(): string[] {
  return acceptedTokens().map((t) => t.symbol);
}

export function tokenBySymbol(symbol: string): ValuedToken | undefined {
  const wanted = symbol.trim().toUpperCase();
  return acceptedTokens().find((t) => t.symbol.toUpperCase() === wanted);
}

export async function usdValueOf(
  token: ValuedToken,
  amountAtomic: bigint,
  readPrices: PriceReader,
): Promise<bigint | null> {
  if (token.symbol === "USDC") return amountAtomic;
  const price = (await readPrices())?.[token.symbol as keyof UsdPrices];
  if (price === undefined) return null;
  return usdcEquivalentAtomic(amountAtomic, token.decimals, price);
}

export async function tokenAmountFor(
  token: ValuedToken,
  usdAtomic: bigint,
  readPrices: PriceReader,
): Promise<bigint | null> {
  if (token.symbol === "USDC") return usdAtomic;
  const price = (await readPrices())?.[token.symbol as keyof UsdPrices];
  if (price === undefined || !Number.isFinite(price) || price <= 0) return null;
  const priceMicros = BigInt(Math.round(price * 1_000_000));
  if (priceMicros <= 0n) return null;
  const numerator = usdAtomic * 10n ** BigInt(token.decimals);
  return (numerator + priceMicros - 1n) / priceMicros;
}
