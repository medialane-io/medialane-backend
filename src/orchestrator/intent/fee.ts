import { resolveFeeConfig, type ResolvedFeeConfig } from "@medialane/sdk";
import { buildFeeCall, type FeeSurface } from "@medialane/sdk/starknet";
import { env } from "../../config/env.js";

export type IntentCall = { contractAddress: string; entrypoint: string; calldata: string[] };
export type IntentBuildContext = { appId: string };

const FEE_APPS = new Set(["MEDIALANE_IO", "MEDIALANE_STARKNET", "MEDIALANE_PORTAL"]);

export const platformFeeConfig: ResolvedFeeConfig = resolveFeeConfig({
  enabled: env.FEE_ENABLED,
  fundAddress: env.FEE_FUND_ADDRESS || undefined,
  marketplaceBps: env.FEE_MARKETPLACE_BPS,
  launchpadBps: env.FEE_LAUNCHPAD_BPS,
  sponsorshipBps: env.FEE_SPONSORSHIP_BPS,
});

export function feeApplies(appId: string, cfg: ResolvedFeeConfig = platformFeeConfig): boolean {
  return FEE_APPS.has(appId) && cfg.enabled && Boolean(cfg.fundAddress);
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
