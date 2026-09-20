import { createFailoverFetch } from "@medialane/sdk";
import { env } from "../config/env.js";
import { createLogger } from "./logger.js";

const log = createLogger("utils:rpcFetch");

const RPC_TIMEOUT_MS = 15_000;

function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

let _rpcFetch: typeof fetch | null = null;

export function rpcFetch(): typeof fetch {
  if (!_rpcFetch) {
    _rpcFetch = createFailoverFetch(rpcEndpoints(), {
      baseFetch: timedFetch as typeof fetch,
      onFailover: ({ url, status }) =>
        log.warn({ rpcUrl: redactRpcUrl(url), status }, "RPC endpoint unavailable, trying the next one"),
    });
  }
  return _rpcFetch;
}

export function rpcEndpoints(): string[] {
  return Array.from(new Set([
    env.ALCHEMY_RPC_URL,
    env.STARKNET_RPC_FALLBACK_URL,
  ].filter((url): url is string => Boolean(url))));
}

export function redactRpcUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid-rpc-url";
  }
}

export async function postRpc<T = unknown>(
  body: object,
  ctx: Record<string, unknown> = {},
): Promise<{ result?: T; error?: unknown }> {
  const json = (await (await rpcFetch()(rpcEndpoints()[0]!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json()) as { result?: T; error?: unknown };

  if (json.result === undefined || json.result === null) {
    log.warn({ ...ctx, rpcError: json.error }, "RPC returned no result");
  }
  return json;
}
