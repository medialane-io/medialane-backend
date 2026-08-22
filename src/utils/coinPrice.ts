import { getQuotes as avnuGetQuotes } from "@avnu/avnu-sdk";
import { getTokenBySymbol } from "@medialane/sdk";

export interface CoinPriceQuote {
  usdc: number;
}

export interface CoinPriceDeps {
  getQuotes: typeof avnuGetQuotes;
  now: () => number;
  ttlMs: number;
}

export const COIN_PRICE_TTL_MS = 60_000;

const cache = new Map<string, { value: CoinPriceQuote | null; fetchedAt: number }>();

export function clearCoinPriceCache(): void {
  cache.clear();
}

export interface CoinPriceInput {
  contractAddress: string;
  decimals: number;
}

export const QUOTE_NOTIONAL_USDC = 10;

async function quoteOne(
  coin: CoinPriceInput,
  usdcAddress: string,
  usdcDecimals: number,
  deps: CoinPriceDeps,
): Promise<CoinPriceQuote | null> {
  if (BigInt(coin.contractAddress) === BigInt(usdcAddress)) return { usdc: 1 };

  const sellAmount = BigInt(QUOTE_NOTIONAL_USDC) * 10n ** BigInt(usdcDecimals);
  const quotes = await deps.getQuotes({
    sellTokenAddress: usdcAddress,
    buyTokenAddress: coin.contractAddress,
    sellAmount,
  });

  const best = quotes[0];
  if (!best?.buyAmount) return null;

  const coinsOut = Number(BigInt(best.buyAmount)) / 10 ** coin.decimals;
  if (!(coinsOut > 0) || !isFinite(coinsOut)) return null;

  const usdc = QUOTE_NOTIONAL_USDC / coinsOut;
  return usdc > 0 && isFinite(usdc) ? { usdc } : null;
}

export async function getCoinPrices(
  coins: CoinPriceInput[],
  deps: CoinPriceDeps = { getQuotes: avnuGetQuotes, now: Date.now, ttlMs: COIN_PRICE_TTL_MS },
): Promise<Record<string, CoinPriceQuote | null>> {
  const usdc = getTokenBySymbol("USDC");
  if (!usdc) return {};

  const now = deps.now();
  const out: Record<string, CoinPriceQuote | null> = {};
  const stale: CoinPriceInput[] = [];

  for (const coin of coins) {
    const hit = cache.get(coin.contractAddress);
    if (hit && now - hit.fetchedAt < deps.ttlMs) out[coin.contractAddress] = hit.value;
    else stale.push(coin);
  }

  const results = await Promise.all(
    stale.map(async (coin) => {
      const value = await quoteOne(coin, usdc.address, usdc.decimals, deps).catch(() => null);
      return [coin.contractAddress, value] as const;
    }),
  );

  for (const [address, value] of results) {
    cache.set(address, { value, fetchedAt: now });
    out[address] = value;
  }

  return out;
}
