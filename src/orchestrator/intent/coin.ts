

import { normalizeAddress } from "../../utils/starknet.js";
import { buildCreateCreatorCoinCall, buildLaunchOnEkuboCalls, priceToEkuboParams, validatePrice } from "@medialane/sdk/starknet";
import { getTokenByAddress } from "@medialane/sdk";
import type { CreateCoinIntentBody, LaunchCoinIntentBody } from "../../types/api.js";

export async function buildCreateCoinIntent(body: CreateCoinIntentBody) {
  const owner = normalizeAddress("STARKNET", body.owner);
  const call = buildCreateCreatorCoinCall({
    owner,
    name: body.name,
    symbol: body.symbol,
    initialSupply: BigInt(body.initialSupply),
    salt: body.salt ? BigInt(body.salt) : undefined,
  });
  return { calls: [call] };
}

export async function buildLaunchCoinIntent(body: LaunchCoinIntentBody) {
  const creatorCoin = normalizeAddress("STARKNET", body.creatorCoin);
  const quoteToken = normalizeAddress("STARKNET", body.quoteToken);

  const token = getTokenByAddress(quoteToken);
  if (!token) throw new Error(`Unsupported quote token: ${body.quoteToken}`);

  const priceError = validatePrice(token.decimals, body.price);
  if (priceError) throw new Error(priceError);

  const calls = buildLaunchOnEkuboCalls({
    creatorCoin,
    quoteToken,
    ekubo: priceToEkuboParams(token.decimals, body.price),
    initialHolders: body.initialHolders.map((h) => normalizeAddress("STARKNET", h)),
    initialHoldersAmounts: body.initialHoldersAmounts.map((a) => BigInt(a)),
    transferRestrictionDelay: body.transferRestrictionDelay,
    maxPercentageBuyLaunch: body.maxPercentageBuyLaunch,
    quoteFundAmount: body.quoteFundAmount ? BigInt(body.quoteFundAmount) : undefined,
  });
  return { calls };
}
