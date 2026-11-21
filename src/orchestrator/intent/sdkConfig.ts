import { resolveConfig, type ResolvedConfig } from "@medialane/sdk";
import { platformFeeConfig } from "./fee.js";

export const sdkConfig: ResolvedConfig = resolveConfig({});

export const fundConfig: ResolvedConfig = { ...sdkConfig, feeConfig: platformFeeConfig };
