/**
 * x402 payment configuration. USDC on Starknet is the v1 settlement asset;
 * CREDITS_PER_USDC and the MDLN bonus tiers mirror the (now-retired) portal
 * deposit model so pricing is unchanged for callers.
 */
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
  usdcContract:
    process.env.STARKNET_USDC_CONTRACT ??
    "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
  /** Where agents send USDC. Required for x402 to function. */
  treasury: process.env.X402_TREASURY_ADDRESS ?? "",
  /** MDLN token contract (for the bonus multiplier). */
  mdlnContract: process.env.STARKNET_MDLN_CONTRACT ?? "",
  /** Price (in USDC atomic units, 6dp) of one credit. 1 credit = $0.01. */
  usdcAtomicPerCredit: 10_000n, // 0.01 USDC * 10^6
} as const;
