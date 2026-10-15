import { RpcProvider, num } from "starknet";
import { rpcEndpoints, rpcFetch } from "./rpcFetch.js";

let _provider: RpcProvider | null = null;

export function createProvider(): RpcProvider {
  if (!_provider) {
    _provider = new RpcProvider({
      nodeUrl: rpcEndpoints()[0],
      blockIdentifier: "latest",
      baseFetch: rpcFetch(),
    });
  }
  return _provider;
}

const CONTRACT_NOT_FOUND = 20;

export function isContractNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === CONTRACT_NOT_FOUND;
}

export async function callRpc<T>(fn: (provider: RpcProvider) => Promise<T>): Promise<T> {
  return fn(createProvider());
}

export { normalizeAddress, normalizeHash } from "@medialane/sdk";

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
