
import { env } from "./env.js";

export const CREDITS_PER_USDC = 100;

export const USDC_DECIMALS = 6;

export const MDLN_TIERS: ReadonlyArray<{ minWholeTokens: bigint; multiplier: number }> = [
  { minWholeTokens: 5000n, multiplier: 2.0 },
  { minWholeTokens: 2000n, multiplier: 1.5 },
  { minWholeTokens: 500n, multiplier: 1.2 },
  { minWholeTokens: 0n, multiplier: 1.0 },
];

export const x402Config = {

  usdcContract: env.STARKNET_USDC_CONTRACT,

  treasury: env.STARKNET_X402_TREASURY,

  mdlnContract: env.STARKNET_MDLN_CONTRACT,

  usdcAtomicPerCredit: 10_000n,
} as const;
