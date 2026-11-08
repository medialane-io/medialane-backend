import { resolveConfig, type ResolvedConfig } from "@medialane/sdk";
import { platformFeeConfig } from "./fee.js";

export const sdkConfig: ResolvedConfig = resolveConfig({});

/** The SDK configuration for intents that pay the platform fund, such as funding transfers. */
export const fundConfig: ResolvedConfig = { ...sdkConfig, feeConfig: platformFeeConfig };
