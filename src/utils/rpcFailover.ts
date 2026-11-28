const TRANSIENT_MESSAGE_RE =
  /unable to complete|rate.?limit|too many|throttl|exceed.*quota|temporarily unavailable|service unavailable|overload|gateway.*time|upstream.*time|backend.*error/i;

function isProviderFault(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== "number") return true;
  if (code === 429 || code === -32600 || code === -32603 || (code >= -32099 && code <= -32000)) return true;
  return code <= 0 && typeof message === "string" && TRANSIENT_MESSAGE_RE.test(message);
}

function isRpcEnvelope(envelope: unknown): envelope is { result?: unknown; error?: unknown } {
  if (!envelope || typeof envelope !== "object") return false;
  const { error } = envelope as { error?: unknown };
  return "result" in envelope || (typeof error === "object" && error !== null);
}

function everyEnvelope(parsed: unknown, accepts: (envelope: unknown) => boolean): boolean {
  return Array.isArray(parsed) ? parsed.length > 0 && parsed.every(accepts) : accepts(parsed);
}

const isUsableEnvelope = (envelope: unknown): boolean =>
  isRpcEnvelope(envelope) && (envelope.error === undefined || !isProviderFault(envelope.error));

export const isRpcResponse = (parsed: unknown): boolean => everyEnvelope(parsed, isRpcEnvelope);

export function isTransientRpcError(input: { status?: number; body?: unknown }): boolean {
  const { status, body } = input;
  if (typeof status === "number" && (status < 200 || status >= 300)) return true;

  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return true;
    }
  }
  return !everyEnvelope(parsed, isUsableEnvelope);
}

const DEFAULT_COOLDOWN_MS = 30_000;

export const RPC_UNAVAILABLE = "RPC unavailable: every endpoint refused or failed";

export class RpcUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(RPC_UNAVAILABLE, { cause });
    this.name = "RpcUnavailableError";
  }
}

export const isRpcUnavailable = (err: unknown): boolean => err instanceof Error && err.message === RPC_UNAVAILABLE;

export type FailoverFetch = typeof fetch & { readyIn(): number };

export interface FailoverFetchOptions {
  baseFetch?: typeof fetch;
  cooldownMs?: number;
  now?: () => number;
  onFailover?: (info: { url: string; status?: number; error?: unknown }) => void;
}

export function createFailoverFetch(
  urls: string[],
  options: FailoverFetchOptions = {},
): FailoverFetch {
  const endpoints = urls.filter((u): u is string => Boolean(u));
  if (endpoints.length === 0) {
    throw new Error("createFailoverFetch: at least one RPC URL is required");
  }
  const doFetch = options.baseFetch ?? fetch;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  const coolingUntil = endpoints.map(() => 0);

  const failover = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const indexes = endpoints.map((_, i) => i);
    const ready = indexes.filter((i) => coolingUntil[i]! <= now());
    const order = [...ready, ...indexes.filter((i) => !ready.includes(i))];
    let lastError: unknown;

    for (const [position, i] of order.entries()) {
      const url = endpoints[i]!;
      let failure: { status?: number; error?: unknown };
      try {
        const res = await doFetch(url, init);
        const text = await res.text();
        if (!isTransientRpcError({ status: res.status, body: text })) {
          return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
        }
        failure = { status: res.status };
      } catch (error) {
        failure = { error };
        lastError = error;
      }
      coolingUntil[i] = now() + cooldownMs;
      if (position < order.length - 1) options.onFailover?.({ url, ...failure });
    }

    throw new RpcUnavailableError(lastError);
  };

  const readyIn = () => Math.max(0, Math.min(...coolingUntil) - now());

  return Object.assign(failover as unknown as typeof fetch, { readyIn });
}
