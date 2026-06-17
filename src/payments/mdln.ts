import { Contract, uint256 } from "starknet";
import { callRpc } from "../utils/starknet.js";
import { MDLN_TIERS, x402Config } from "../config/x402.js";

/** Pure: whole-token MDLN balance → credit multiplier (descending tier match). */
export function multiplierForBalance(wholeTokens: bigint): number {
  for (const tier of MDLN_TIERS) {
    if (wholeTokens >= tier.minWholeTokens) return tier.multiplier;
  }
  return 1.0;
}

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "core::starknet::contract_address::ContractAddress" }],
    outputs: [{ name: "balance", type: "core::integer::u256" }],
    state_mutability: "view",
  },
] as const;

/** Reads MDLN balance (whole tokens, 18dp) for `address` → multiplier.
 *  Returns 1.0 on any failure or if MDLN is unconfigured — never blocks a payment. */
export async function mdlnMultiplier(address: string): Promise<number> {
  if (!x402Config.mdlnContract || !address) return 1.0;
  try {
    const raw = await callRpc(async (provider) => {
      const c = new Contract(ERC20_ABI as never, x402Config.mdlnContract, provider as never);
      const res = await c.balanceOf(address);
      return uint256.uint256ToBN(res.balance ?? res);
    });
    const whole = raw / 10n ** 18n;
    return multiplierForBalance(whole);
  } catch {
    return 1.0;
  }
}
