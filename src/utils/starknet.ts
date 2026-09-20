import { RpcProvider, num } from "starknet";
import { env } from "../config/env.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import { createLogger } from "./logger.js";

const log = createLogger("utils:starknet");

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

const FALLBACK_RPC_URL = env.STARKNET_RPC_FALLBACK_URL;

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

export function hasFallback(): boolean {
  return Boolean(FALLBACK_RPC_URL);
}

function getFallback(): RpcProvider {
  if (!FALLBACK_RPC_URL) throw new Error("STARKNET_RPC_FALLBACK_URL is not set, so there is no RPC to fall back to");
  if (!_fallback) {
    _fallback = new RpcProvider({
      nodeUrl: FALLBACK_RPC_URL,
      blockIdentifier: "latest",
      fetch: timedFetch as typeof fetch,
    } as any);
  }
  return _fallback;
}

export function createProvider(): RpcProvider {
  if (breaker.shouldUsePrimary() || !hasFallback()) return getPrimary();
  log.debug("Circuit breaker OPEN, using the fallback RPC");
  return getFallback();
}

export async function callRpc<T>(fn: (provider: RpcProvider) => Promise<T>): Promise<T> {
  const usePrimary = breaker.shouldUsePrimary() || !hasFallback();
  const provider = usePrimary ? getPrimary() : getFallback();
  try {
    const result = await fn(provider);
    if (usePrimary) breaker.recordSuccess();
    return result;
  } catch (err) {
    if (usePrimary && hasFallback()) {
      breaker.recordFailure();

      log.warn("Primary RPC failed, retrying on the fallback");
      return fn(getFallback());
    }
    throw err;
  }
}

export { normalizeAddress, normalizeHash } from "@medialane/sdk";

export function feltToHex(felt: string | bigint): string {
  try {
    const n = typeof felt === "bigint" ? felt : BigInt(felt);
    return "0x" + n.toString(16);
  } catch {
    return "0x0";
  }
}

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
