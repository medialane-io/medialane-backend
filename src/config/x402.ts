/**
 * x402 payment configuration. USDC on Starknet is the v1 settlement asset;
 * CREDITS_PER_USDC and the MDLN bonus tiers mirror the (now-retired) portal
 * deposit model so pricing is unchanged for callers.
 */
import { env } from "./env.js";

export const CREDITS_PER_USDC = 100;

/** USDC has 6 decimals on Starknet. */
export const USDC_DECIMALS = 6;

/** MDLN bonus: more held → more credits per USDC. Thresholds in whole MDLN.
 *  Sorted high→low so the first match in mdln.ts wins. */
export const MDLN_TIERS: ReadonlyArray<{ minWholeTokens: bigint; multiplier: number }> = [
  { minWholeTokens: 5000n, multiplier: 2.0 },
  { minWholeTokens: 2000n, multiplier: 1.5 },
  { minWholeTokens: 500n, multiplier: 1.2 },
  { minWholeTokens: 0n, multiplier: 1.0 },
];

export const x402Config = {
  /** USDC token contract on Starknet (atomic settlement asset).
   *  Circle-native USDC (canonical, per @medialane/sdk coordinates) — NOT the
   *  legacy bridged USDC.e (0x053c9125…). */
  usdcContract: env.STARKNET_USDC_CONTRACT,
  /** Where agents send USDC — the Creator's Fund Starknet multisig. */
  treasury: env.STARKNET_X402_TREASURY,
  /** MDLN token contract (for the bonus multiplier). */
  mdlnContract: env.STARKNET_MDLN_CONTRACT,
  /** Price (in USDC atomic units, 6dp) of one credit. 1 credit = $0.01. */
  usdcAtomicPerCredit: 10_000n, // 0.01 USDC * 10^6
} as const;
