import { env } from "../config/env.js";
import { PUBLIC_RPC_FALLBACKS } from "@medialane/sdk";
import { createLogger } from "./logger.js";

const log = createLogger("utils:rpcFetch");

// Each RPC request gets 15s before being aborted — prevents hang accumulation.
const RPC_TIMEOUT_MS = 15_000;

/**
 * Ordered Starknet RPC endpoints: configured private endpoints first, then the
 * SDK's shared public fallback list (lava.build, …). Single source of the
 * endpoint order, shared by every raw-fetch RPC path in the backend.
 */
export function rpcEndpoints(): string[] {
  return Array.from(new Set([
    env.ALCHEMY_RPC_URL,
    env.STARKNET_RPC_FALLBACK_URL,
    ...PUBLIC_RPC_FALLBACKS,
  ].filter((url): url is string => Boolean(url))));
}

/** Host + first path segments only — never log API keys embedded in the URL. */
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.split("/").slice(0, 4).join("/")}`;
  } catch {
    return "invalid-rpc-url";
  }
}

/**
 * POST a JSON-RPC request, rotating across {@link rpcEndpoints} until one
 * returns a `result`. An endpoint that responds with a JSON-RPC `error`, an
 * empty body, or a network/timeout failure is logged and skipped; if no
 * endpoint yields a result, the last error is thrown.
 *
 * Single source for the rotation loop that was previously hand-copied into
 * txVerifier (receipts), orderCreated (1155 order details), and intent
 * (counter / royalty reads). Callers keep their own result decoding/validation.
 *
 * `ctx` is merged into the warn logs for traceability (e.g. `{ txHash }`).
 */
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
