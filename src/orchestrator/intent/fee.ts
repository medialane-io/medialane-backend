import { resolveFeeConfig, type ResolvedFeeConfig } from "@medialane/sdk";
import { buildFeeCall, feeBps, type FeeSurface } from "@medialane/sdk/starknet";
import { x402Config } from "../../config/x402.js";

export type IntentCall = { contractAddress: string; entrypoint: string; calldata: string[] };
export type IntentBuildContext = { appId: string };

const FEE_APPS = new Set(["MEDIALANE_IO", "MEDIALANE_STARKNET", "MEDIALANE_PORTAL"]);

export const platformFeeConfig: ResolvedFeeConfig = resolveFeeConfig({ fundAddress: x402Config.treasury });

export function feeApplies(appId: string, cfg: ResolvedFeeConfig = platformFeeConfig): boolean {
  return FEE_APPS.has(appId) && cfg.enabled && Boolean(cfg.fundAddress);
}

/** Launchpad fee, in basis points, that intents built for `appId` add to a mint. */
export function dropFeeBps(appId: string, cfg: ResolvedFeeConfig = platformFeeConfig): number {
  return feeApplies(appId, cfg) ? feeBps("launchpad", cfg) : 0;
}

export function platformFeeCalls(
  appId: string,
  surface: FeeSurface,
  token: string,
  grossAmount: bigint,
  cfg: ResolvedFeeConfig = platformFeeConfig,
): IntentCall[] {
  if (!feeApplies(appId, cfg)) return [];
  const call = buildFeeCall({ surface, token, grossAmount }, cfg);
  if (!call) return [];
  return [{ contractAddress: call.contractAddress, entrypoint: call.entrypoint, calldata: (call.calldata as string[]).map(String) }];
}
