import { RpcProvider, num } from "starknet";
import { env } from "../config/env.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { createLogger } from "./logger.js";

const log = createLogger("utils:starknet");

// Each RPC call gets 15s before being aborted — prevents hang accumulation
const RPC_FETCH_TIMEOUT_MS = 15_000;

function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_FETCH_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

const breaker = new CircuitBreaker();

let _primary: RpcProvider | null = null;
let _fallback: RpcProvider | null = null;

function getPrimary(): RpcProvider {
  if (!_primary) {
    _primary = new RpcProvider({
      nodeUrl: env.ALCHEMY_RPC_URL,
      blockIdentifier: "latest",
      fetch: timedFetch as typeof fetch,
    } as any);
  }
  return _primary;
}

function getFallback(): RpcProvider | null {
  if (!env.STARKNET_RPC_FALLBACK_URL) return null;
  if (!_fallback) {
    _fallback = new RpcProvider({
      nodeUrl: env.STARKNET_RPC_FALLBACK_URL,
      blockIdentifier: "latest",
      fetch: timedFetch as typeof fetch,
    } as any);
  }
  return _fallback;
}

/**
 * Returns the appropriate RpcProvider based on circuit-breaker state.
 * - CLOSED: primary
 * - OPEN (within cool-down) + fallback configured: fallback
 * - OPEN (within cool-down) + no fallback: primary (degraded)
 * - HALF (probe window): primary
 *
 * Callers that want automatic failure tracking should use `callRpc()` instead.
 */
export function createProvider(): RpcProvider {
  if (breaker.shouldUsePrimary()) return getPrimary();
  const fb = getFallback();
  if (fb) {
    log.debug("Circuit breaker OPEN — using fallback RPC");
    return fb;
  }
  // No fallback configured — use primary regardless
  return getPrimary();
}

/**
 * Execute an RPC call with circuit-breaker tracking.
 * Use this wrapper in indexer / orchestrator hot paths.
 */
export async function callRpc<T>(fn: (provider: RpcProvider) => Promise<T>): Promise<T> {
  const usePrimary = breaker.shouldUsePrimary();
  const provider = usePrimary ? getPrimary() : (getFallback() ?? getPrimary());
  try {
    const result = await fn(provider);
    if (usePrimary) breaker.recordSuccess();
    return result;
  } catch (err) {
    if (usePrimary) {
      breaker.recordFailure();
      // One automatic retry on fallback if available
      const fb = getFallback();
      if (fb) {
        log.warn("Primary RPC failed — retrying on fallback");
        return fn(fb);
      }
    }
    throw err;
  }
}

/**
 * Normalize a Starknet address to a 0x-prefixed 64-char hex string (padded).
 */
export function normalizeAddress(address: string): string {
  try {
    const hex = num.toHex(BigInt(address));
    return "0x" + hex.slice(2).padStart(64, "0");
  } catch {
    throw new Error(`Invalid Starknet address: "${address}"`);
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
