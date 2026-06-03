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

// Public Starknet mainnet fallback (RPC spec 0.8.1, no API key). Defaults to
// lava.build so the circuit breaker ALWAYS has somewhere to fail over when
// Alchemy returns its intermittent 503 / -32001 "Unable to complete request"
// — even when STARKNET_RPC_FALLBACK_URL is unset. Same endpoint already used
// as a fallback in txVerifier + orderCreated handlers.
const FALLBACK_RPC_URL = env.STARKNET_RPC_FALLBACK_URL || "https://rpc.starknet.lava.build/";

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

function getFallback(): RpcProvider {
  if (!_fallback) {
    _fallback = new RpcProvider({
      nodeUrl: FALLBACK_RPC_URL,
      blockIdentifier: "latest",
      fetch: timedFetch as typeof fetch,
    } as any);
  }
  return _fallback;
}

/**
 * Returns the appropriate RpcProvider based on circuit-breaker state.
 * - CLOSED / HALF (probe window): primary
 * - OPEN (within cool-down): fallback (always configured — see FALLBACK_RPC_URL)
 *
 * Callers that want automatic failure tracking should use `callRpc()` instead.
 */
export function createProvider(): RpcProvider {
  if (breaker.shouldUsePrimary()) return getPrimary();
  log.debug("Circuit breaker OPEN — using fallback RPC");
  return getFallback();
}

/**
 * Execute an RPC call with circuit-breaker tracking.
 * Use this wrapper in indexer / orchestrator hot paths.
 */
export async function callRpc<T>(fn: (provider: RpcProvider) => Promise<T>): Promise<T> {
  const usePrimary = breaker.shouldUsePrimary();
  const provider = usePrimary ? getPrimary() : getFallback();
  try {
    const result = await fn(provider);
    if (usePrimary) breaker.recordSuccess();
    return result;
  } catch (err) {
    if (usePrimary) {
      breaker.recordFailure();
      // One automatic retry on the fallback endpoint.
      log.warn("Primary RPC failed — retrying on fallback");
      return fn(getFallback());
    }
    throw err;
  }
}

// `normalizeAddress` + `normalizeHash` live in @medialane/sdk (single source of
// truth — backend re-exports so existing import paths keep working).
export { normalizeAddress, normalizeHash } from "@medialane/sdk";

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

/** Decode a Cairo felt252 short string into its ASCII representation. */
export function decodeShortstring(felt: unknown): string {
  try {
    let n = BigInt(String(felt));
    const bytes: number[] = [];
    while (n > 0n) {
      bytes.unshift(Number(n & 0xffn));
      n >>= 8n;
    }
    return Buffer.from(bytes).toString("ascii");
  } catch {
    return String(felt);
  }
}
