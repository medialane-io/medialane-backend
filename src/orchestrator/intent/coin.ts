// Creator Coin intents: CREATE_COIN (deploy) then LAUNCH_COIN (Ekubo launch).
// Two-step because the coin address is only known from the CREATE_COIN
// receipt — same shape as CREATE_TIER → MINT. No SNIP-12 signing required.
import { normalizeAddress } from "../../utils/starknet.js";
import { buildCreateCreatorCoinCall, buildLaunchOnEkuboCalls } from "@medialane/sdk/starknet";
import type { CreateCoinIntentBody, LaunchCoinIntentBody } from "../../types/api.js";

/**
 * Build a CREATE_COIN intent — no SNIP-12 signing required.
 *
 * Deploys a fixed-supply CreatorCoin via the Factory (full supply minted to
 * the Factory until launch). Calldata comes from the SDK's account-free
 * `buildCreateCreatorCoinCall` — the same builder both apps' launch flows
 * used to call directly client-side; the backend now sits in front of it so
 * the deploy is metered like every other collection/coin creation.
 */
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

/**
 * Build a LAUNCH_COIN intent — no SNIP-12 signing required.
 *
 * Launches an already-deployed CreatorCoin on Ekubo (owner-only — the
 * contract itself is the authority; an unauthorized caller simply reverts,
 * same as before this routed through the backend). Optionally pre-funds the
 * Factory with quote in the same multicall for the team-allocation buyback.
 * The coin address is only known from the CREATE_COIN receipt, so this is a
 * separate intent built after that tx confirms — same two-step shape as
 * CREATE_TIER → MINT.
 */
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
