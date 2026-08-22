import { Hono } from "hono";
import { validateAndParseAddress } from "starknet";
import { getQuotes as avnuGetQuotes, quoteToCalls as avnuQuoteToCalls } from "@avnu/avnu-sdk";
import { getTokenBySymbol, stringifyBigInts } from "@medialane/sdk";
import { createLogger } from "../../utils/logger.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:swap");

const DEFAULT_SLIPPAGE = 0.01;

export interface SwapDeps {
  getQuotes: typeof avnuGetQuotes;
  quoteToCalls: typeof avnuQuoteToCalls;
}

export interface SwapTokenInput {
  symbol?: string;
  address?: string;
}

export function resolveSwapToken(input: SwapTokenInput): { address: string } | null {
  const hasSymbol = Boolean(input.symbol);
  const hasAddress = Boolean(input.address);
  if (hasSymbol === hasAddress) return null;

  if (hasSymbol) {
    const token = getTokenBySymbol(input.symbol!);
    return token ? { address: token.address } : null;
  }

  try {
    return { address: validateAndParseAddress(input.address!.trim()) };
  } catch {
    return null;
  }
}

export function resolveSwapAmount(input: {
  sellAmountRaw?: string;
  buyAmountRaw?: string;
}): { sellAmount: bigint } | { buyAmount: bigint } | null {
  const hasSell = Boolean(input.sellAmountRaw);
  const hasBuy = Boolean(input.buyAmountRaw);
  if (hasSell === hasBuy) return null;
  try {
    return hasSell
      ? { sellAmount: BigInt(input.sellAmountRaw!) }
      : { buyAmount: BigInt(input.buyAmountRaw!) };
  } catch {
    return null;
  }
}

interface SwapRequestBody {
  sellSymbol?: string;
  buySymbol?: string;
  sellTokenAddress?: string;
  buyTokenAddress?: string;
  sellAmountRaw?: string;
  buyAmountRaw?: string;
  takerAddress?: string;
}

function parseSwapRequest(body: SwapRequestBody | null) {
  if (!body) return null;
  const sellToken = resolveSwapToken({ symbol: body.sellSymbol, address: body.sellTokenAddress });
  const buyToken = resolveSwapToken({ symbol: body.buySymbol, address: body.buyTokenAddress });
  const amount = resolveSwapAmount(body);
  if (!sellToken || !buyToken || !amount) return null;
  return { sellToken, buyToken, amount };
}

export default function swap(
  deps: SwapDeps = { getQuotes: avnuGetQuotes, quoteToCalls: avnuQuoteToCalls },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/quote", async (c) => {
    const body = (await c.req.json().catch(() => null)) as SwapRequestBody | null;
    const parsed = parseSwapRequest(body);
    if (!parsed) {
      return c.json(
        { error: "Unsupported currency, or exactly one of sellAmountRaw/buyAmountRaw must be given" },
        400,
      );
    }

    try {
      const quotes = await deps.getQuotes({
        sellTokenAddress: parsed.sellToken.address,
        buyTokenAddress: parsed.buyToken.address,
        ...parsed.amount,
        takerAddress: body!.takerAddress,
      });
      const best = quotes[0];
      if (!best) return c.json({ error: "No swap route available for this pair" }, 502);
      return c.json(stringifyBigInts({ quote: best }));
    } catch (err) {
      log.warn({ err }, "swap quote failed");
      return c.json({ error: "Failed to fetch swap quote" }, 502);
    }
  });

  app.post("/build", async (c) => {
    const body = (await c.req.json().catch(() => null)) as SwapRequestBody | null;
    if (!body?.takerAddress) {
      return c.json({ error: "takerAddress is required" }, 400);
    }

    const parsed = parseSwapRequest(body);
    if (!parsed) {
      return c.json(
        { error: "Unsupported currency, or exactly one of sellAmountRaw/buyAmountRaw must be given" },
        400,
      );
    }

    try {
      const quotes = await deps.getQuotes({
        sellTokenAddress: parsed.sellToken.address,
        buyTokenAddress: parsed.buyToken.address,
        ...parsed.amount,
        takerAddress: body.takerAddress,
      });
      const quote = quotes[0];
      if (!quote) return c.json({ error: "No swap route available for this pair" }, 502);

      const built = await deps.quoteToCalls({
        quoteId: quote.quoteId,
        slippage: DEFAULT_SLIPPAGE,
        takerAddress: body.takerAddress,
      });

      return c.json(stringifyBigInts({ calls: built.calls, chainId: built.chainId, quote }));
    } catch (err) {
      log.warn({ err }, "swap build failed");
      return c.json({ error: "Failed to build swap calls" }, 502);
    }
  });

  return app;
}
