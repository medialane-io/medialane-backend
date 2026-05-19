import { resolveFeeConfig } from "@medialane/sdk";

export const backendFeeConfig = resolveFeeConfig({
  enabled: process.env.FEE_ENABLED !== "false",
  fundAddress: process.env.FEE_FUND_ADDRESS || undefined,
  marketplaceBps: process.env.FEE_MARKETPLACE_BPS
    ? Number(process.env.FEE_MARKETPLACE_BPS)
    : 100,
  launchpadBps: process.env.FEE_LAUNCHPAD_BPS
    ? Number(process.env.FEE_LAUNCHPAD_BPS)
    : 100,
});
