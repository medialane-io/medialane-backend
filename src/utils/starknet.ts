import { RpcProvider, num } from "starknet";
import { env } from "../config/env.js";

// Each RPC call gets 15s before being aborted — prevents hang accumulation
const RPC_FETCH_TIMEOUT_MS = 15_000;

function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_FETCH_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

export function createProvider(): RpcProvider {
  return new RpcProvider({
    nodeUrl: env.ALCHEMY_RPC_URL,
    blockIdentifier: "latest",
    fetch: timedFetch as typeof fetch,
  } as any);
}

/**
 * Normalize a Starknet address to a 0x-prefixed 64-char hex string (padded).
 */
export function normalizeAddress(address: string): string {
  try {
    const hex = num.toHex(BigInt(address));
    return "0x" + hex.slice(2).padStart(64, "0");
  } catch {
    return address.toLowerCase();
  }
}

/**
 * Convert a raw felt (possibly as decimal string or hex) to 0x-prefixed hex.
 */
export function feltToHex(felt: string | bigint): string {
  try {
    const n = typeof felt === "bigint" ? felt : BigInt(felt);
    return "0x" + n.toString(16);
  } catch {
    return "0x0";
  }
}
