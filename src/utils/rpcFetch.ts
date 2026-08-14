import { env } from "../config/env.js";
import { PUBLIC_RPC_FALLBACKS } from "@medialane/sdk";
import { createLogger } from "./logger.js";

const log = createLogger("utils:rpcFetch");

const RPC_TIMEOUT_MS = 15_000;

export function rpcEndpoints(): string[] {
  return Array.from(new Set([
    env.ALCHEMY_RPC_URL,
    env.STARKNET_RPC_FALLBACK_URL,
    ...PUBLIC_RPC_FALLBACKS,
  ].filter((url): url is string => Boolean(url))));
}

export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.split("/").slice(0, 4).join("/")}`;
  } catch {
    return "invalid-rpc-url";
  }
}

export async function postRpc<T = unknown>(
  body: object,
  ctx: Record<string, unknown> = {},
): Promise<{ result?: T; error?: unknown }> {
  let lastError: unknown;

  for (const url of rpcEndpoints()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json()) as { result?: T; error?: unknown };
      if (json.result !== undefined && json.result !== null) return json;
      lastError = json.error ?? new Error(`Empty RPC response from ${redactRpcUrl(url)}`);
      log.warn({ ...ctx, rpcUrl: redactRpcUrl(url), rpcError: json.error }, "RPC returned no result — trying next endpoint");
    } catch (err) {
      lastError = err;
      log.warn({ ...ctx, rpcUrl: redactRpcUrl(url), err }, "RPC request failed — trying next endpoint");
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(typeof lastError === "object" ? JSON.stringify(lastError) : String(lastError));
}
