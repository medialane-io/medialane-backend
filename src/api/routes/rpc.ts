import { Hono } from "hono";
import { rpcEndpoints, redactRpcUrl } from "../../utils/rpcFetch.js";
import { createLogger } from "../../utils/logger.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:rpc");

export const ALLOWED_RPC_METHODS: readonly string[] = [
  "starknet_call",
  "starknet_addInvokeTransaction",
  "starknet_getTransactionReceipt",
  "starknet_getTransactionStatus",
  "starknet_getTransactionByHash",
  "starknet_getTransaction",
  "starknet_getBlockWithReceipts",
  "starknet_estimateFee",
  "starknet_getNonce",
  "starknet_simulateTransactions",
  "starknet_specVersion",
  "starknet_chainId",
  "starknet_blockNumber",
  "starknet_blockHashAndNumber",
  "starknet_getClassAt",
  "starknet_getClass",
  "starknet_getClassHashAt",
  "starknet_getStorageAt",
  "starknet_getBlockWithTxHashes",
  "starknet_getBlockWithTxs",
  "starknet_getEvents",
];

const ALLOWED_METHODS = new Set<string>(ALLOWED_RPC_METHODS);

const RPC_TIMEOUT_MS = 15_000;

const MAX_GET_EVENTS_CHUNK_SIZE = 100;

export const MAX_RPC_BATCH_SIZE = 20;

function isAllowedSingleCall(body: Record<string, unknown>): boolean {
  const method = body.method;
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) return false;
  if (method === "starknet_getEvents") {
    const params = Array.isArray(body.params) ? (body.params[0] as Record<string, unknown> | undefined) : undefined;
    const chunkSize = params?.chunk_size;
    return typeof chunkSize === "number" && chunkSize > 0 && chunkSize <= MAX_GET_EVENTS_CHUNK_SIZE;
  }
  return true;
}

export function isAllowedRpcBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MAX_RPC_BATCH_SIZE) return false;
    return body.every((item) => isAllowedRpcBody(item));
  }
  if (body && typeof body === "object") {
    return isAllowedSingleCall(body as Record<string, unknown>);
  }
  return false;
}

export function extractRpcMethod(body: unknown): string {
  if (Array.isArray(body)) return "batch";
  if (body && typeof body === "object") {
    const method = (body as Record<string, unknown>).method;
    if (typeof method === "string") return method;
  }
  return "unknown";
}

function rpcError(code: number, message: string, id: number | null = null) {
  return { jsonrpc: "2.0", error: { code, message }, id };
}

export default function rpc(fetchImpl: typeof fetch = fetch): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(-32700, "Parse error"));
    }

    if (!isAllowedRpcBody(body)) {
      return c.json(rpcError(-32601, `Method not allowed: ${extractRpcMethod(body)}`));
    }

    const method = extractRpcMethod(body);
    let lastError = "No RPC upstream configured";

    for (const url of rpcEndpoints()) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
      try {
        const upstream = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await upstream.text();
        if (!text) {
          lastError = "Upstream RPC returned an empty body";
          log.warn({ rpcUrl: redactRpcUrl(url), status: upstream.status, method }, lastError);
          continue;
        }

        try {
          return c.json(JSON.parse(text));
        } catch {
          lastError = "Upstream RPC returned a non-JSON body";
          log.warn({ rpcUrl: redactRpcUrl(url), status: upstream.status, method }, lastError);
          continue;
        }
      } catch (err) {
        lastError = "Upstream RPC unreachable";
        log.warn({ rpcUrl: redactRpcUrl(url), method, err }, lastError);
      } finally {
        clearTimeout(timer);
      }
    }

    return c.json(rpcError(-32603, lastError));
  });

  return app;
}
