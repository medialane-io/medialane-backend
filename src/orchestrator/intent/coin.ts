

import { normalizeAddress } from "../../utils/starknet.js";
import { buildCreateCreatorCoinCall, buildLaunchOnEkuboCalls } from "@medialane/sdk/starknet";
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
  const calls = buildLaunchOnEkuboCalls({
    creatorCoin,
    quoteToken,
    initialHolders: body.initialHolders.map((h) => normalizeAddress("STARKNET", h)),
    initialHoldersAmounts: body.initialHoldersAmounts.map((a) => BigInt(a)),
    transferRestrictionDelay: body.transferRestrictionDelay,
    maxPercentageBuyLaunch: body.maxPercentageBuyLaunch,
    quoteFundAmount: body.quoteFundAmount ? BigInt(body.quoteFundAmount) : undefined,
  });
  return { calls };
}
