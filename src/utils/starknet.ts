import { RpcProvider, num } from "starknet";
import { rpcEndpoints, rpcFetch } from "./rpcFetch.js";

let _provider: RpcProvider | null = null;

export function createProvider(): RpcProvider {
  if (!_provider) {
    _provider = new RpcProvider({
      nodeUrl: rpcEndpoints()[0],
      blockIdentifier: "latest",
      fetch: rpcFetch(),
    } as any);
  }
  return _provider;
}

export async function callRpc<T>(fn: (provider: RpcProvider) => Promise<T>): Promise<T> {
  return fn(createProvider());
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
