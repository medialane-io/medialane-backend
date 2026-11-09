import { buildIntent, buildWalletManageCall, swapCallsWithinBounds } from "@medialane/sdk/starknet";
import { fundConfig } from "./sdkConfig.js";
import { getQuotes as avnuGetQuotes, quoteToCalls as avnuQuoteToCalls } from "@avnu/avnu-sdk";
import { normalizeAddress } from "../../utils/starknet.js";
import { tokenByAddress } from "../../payments/token-value.js";
import { x402Config } from "../../config/x402.js";
import { NoSwapRouteError, resolveSwapAmount, resolveSwapToken, swapCallsFor, type SwapDeps } from "../../api/routes/swap.js";
import type { IntentCall } from "./fee.js";
import { IntentRefusal } from "./refusal.js";

const addr = (a: string) => normalizeAddress("STARKNET", a);
const plain = (c: { contractAddress: string; entrypoint: string; calldata?: unknown }): IntentCall => ({
  contractAddress: c.contractAddress,
  entrypoint: c.entrypoint,
  calldata: Array.isArray(c.calldata) ? (c.calldata as unknown[]).map(String) : [],
});

export type WalletAction = "add_owner" | "remove_owner" | "cancel_escape" | "set_first_guardian" | "trigger_escape" | "complete_escape";

export async function buildWalletManageIntent(body: { owner: string; action: WalletAction; pubkey?: string; ownerGuid?: string; newOwnerPubkey?: string }) {
  try {
    return { calls: [plain(buildWalletManageCall(body))] };
  } catch (err) {
    throw new IntentRefusal(err instanceof Error ? err.message : "Invalid wallet action");
  }
}

export async function buildFundingTransferIntent(body: { owner: string; asset: string; amountAtomic: string }) {
  if (!x402Config.treasury) throw new IntentRefusal("Funding is not configured");
  if (!tokenByAddress(addr(body.asset))) throw new IntentRefusal("That token is not accepted");
  return buildIntent("funding-transfer", body, {}, fundConfig);
}

export async function buildSwapIntent(
  body: { taker: string; sellTokenAddress: string; buyTokenAddress: string; sellAmountRaw?: string; buyAmountRaw?: string },
  deps: SwapDeps = { getQuotes: avnuGetQuotes, quoteToCalls: avnuQuoteToCalls },
) {
  const sellToken = resolveSwapToken({ address: body.sellTokenAddress });
  const buyToken = resolveSwapToken({ address: body.buyTokenAddress });
  const amount = resolveSwapAmount(body);
  if (!sellToken || !buyToken || !amount) {
    throw new IntentRefusal("Unsupported currency, or exactly one of sellAmountRaw/buyAmountRaw must be given");
  }
  try {
    const { calls } = await swapCallsFor({ sellToken, buyToken, amount }, addr(body.taker), deps);
    const route = (calls as { contractAddress: string; entrypoint: string; calldata?: unknown }[]).map(plain);
    if (!swapCallsWithinBounds(body, route)) throw new IntentRefusal("No swap route available for this pair");
    return { calls: route };
  } catch (err) {
    if (err instanceof NoSwapRouteError) throw new IntentRefusal("No swap route available for this pair");
    throw err;
  }
}
