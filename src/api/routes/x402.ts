import { Hono } from "hono";
import { pricingTable } from "../../payments/pricing.js";
import { x402Config, CREDITS_PER_USDC } from "../../config/x402.js";

export const x402Discovery = new Hono();

async function manifest() {
  return {
    x402Version: 1,
    schemes: ["starknet-transfer"],
    network: "starknet",
    asset: x402Config.usdcContract,
    payTo: x402Config.treasury,
    creditsPerUsdc: CREDITS_PER_USDC,
    pricing: await pricingTable(),
  };
}

x402Discovery.get("/.well-known/x402", async (c) => c.json(await manifest()));
x402Discovery.get("/v1/pricing", async (c) => c.json(await manifest()));
