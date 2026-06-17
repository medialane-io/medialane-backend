import { describe, expect, test } from "bun:test";
import { x402Discovery } from "./x402.js";

describe("x402 discovery", () => {
  test("GET /.well-known/x402 advertises schemes + pricing", async () => {
    const res = await x402Discovery.request("/.well-known/x402");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { x402Version: number; schemes: string[]; pricing: { default: number } };
    expect(body.x402Version).toBe(1);
    expect(body.schemes).toContain("starknet-transfer");
    expect(body.pricing.default).toBe(1);
  });

  test("GET /v1/pricing returns the same manifest", async () => {
    const res = await x402Discovery.request("/v1/pricing");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { creditsPerUsdc: number };
    expect(body.creditsPerUsdc).toBe(100);
  });
});
