import {
  buildAddOwnerCall,
  buildRemoveOwnerByGuidCall,
  buildCancelEscapeCall,
  buildSetFirstGuardianCall,
  buildTriggerEscapeOwnerCall,
  buildCompleteEscapeOwnerCall,
} from "@medialane/sdk/starknet";
import { getQuotes as avnuGetQuotes, quoteToCalls as avnuQuoteToCalls } from "@avnu/avnu-sdk";
import { normalizeAddress } from "../../utils/starknet.js";
import { tokenByAddress } from "../../payments/token-value.js";
import { x402Config } from "../../config/x402.js";
import { NoSwapRouteError, resolveSwapAmount, resolveSwapToken, swapCallsFor, type SwapDeps } from "../../api/routes/swap.js";
import type { IntentCall } from "./fee.js";
import { IntentRefusal } from "./refusal.js";
import { encodeU256 } from "@medialane/sdk";

const addr = (a: string) => normalizeAddress("STARKNET", a);
const plain = (c: { contractAddress: string; entrypoint: string; calldata?: unknown }): IntentCall => ({
  contractAddress: c.contractAddress,
  entrypoint: c.entrypoint,
  calldata: Array.isArray(c.calldata) ? (c.calldata as unknown[]).map(String) : [],
});

export type WalletAction = "add_owner" | "remove_owner" | "cancel_escape" | "set_first_guardian" | "trigger_escape" | "complete_escape";

export async function buildWalletManageIntent(body: { owner: string; action: WalletAction; pubkey?: string; ownerGuid?: string; newOwnerPubkey?: string }) {
  const owner = addr(body.owner);
  const need = (v: string | undefined, name: string) => {
    if (!v) throw new IntentRefusal(`${name} is required`);
    return v;
  };
  const build = {
    add_owner: () => buildAddOwnerCall(owner, need(body.pubkey, "pubkey")),
    remove_owner: () => buildRemoveOwnerByGuidCall(owner, need(body.ownerGuid, "ownerGuid")),
    cancel_escape: () => buildCancelEscapeCall(owner),
    set_first_guardian: () => buildSetFirstGuardianCall(owner, need(body.pubkey, "pubkey")),
    trigger_escape: () => buildTriggerEscapeOwnerCall(owner, need(body.newOwnerPubkey, "newOwnerPubkey")),
    complete_escape: () => buildCompleteEscapeOwnerCall(owner),
  }[body.action];
  return { calls: [plain(build())] };
}

export async function buildFundingTransferIntent(body: { owner: string; asset: string; amountAtomic: string }) {
  if (!x402Config.treasury) throw new IntentRefusal("Funding is not configured");
  const token = tokenByAddress(addr(body.asset));
  if (!token) throw new IntentRefusal("That token is not accepted");
  const amount = BigInt(body.amountAtomic);
  const calls: IntentCall[] = [{
    contractAddress: addr(token.address),
    entrypoint: "transfer",
    calldata: [addr(x402Config.treasury), ...encodeU256(amount)],
  }];
  return { calls };
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
    return { calls: (calls as { contractAddress: string; entrypoint: string; calldata?: unknown }[]).map(plain) };
  } catch (err) {
    if (err instanceof NoSwapRouteError) throw new IntentRefusal("No swap route available for this pair");
    throw err;
  }
}
