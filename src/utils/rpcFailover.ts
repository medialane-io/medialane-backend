const TRANSIENT_MESSAGE_RE =
  /unable to complete|rate.?limit|too many|throttl|exceed.*quota|temporarily unavailable|service unavailable|overload|gateway.*time|upstream.*time|backend.*error/i;

function isProviderFault(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== "number") return true;
  if (code === 429 || code === -32600 || code === -32603 || (code >= -32099 && code <= -32000)) return true;
  return code <= 0 && typeof message === "string" && TRANSIENT_MESSAGE_RE.test(message);
}

function isUsableEnvelope(envelope: unknown): boolean {
  if (!envelope || typeof envelope !== "object") return false;
  const body = envelope as { result?: unknown; error?: unknown };
  if (body.error !== undefined) return !isProviderFault(body.error);
  return "result" in body;
}

export function isRpcEnvelope(envelope: unknown): boolean {
  if (!envelope || typeof envelope !== "object") return false;
  const { error } = envelope as { error?: unknown };
  return "result" in envelope || (typeof error === "object" && error !== null);
}

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
  return Array.isArray(parsed) ? parsed.length === 0 || !parsed.every(isUsableEnvelope) : !isUsableEnvelope(parsed);
}

export interface FailoverFetchOptions {

  baseFetch?: typeof fetch;

  onFailover?: (info: { url: string; status?: number; error?: unknown }) => void;
}

export function createFailoverFetch(
  urls: string[],
  options: FailoverFetchOptions = {},
): typeof fetch {
  const endpoints = urls.filter((u): u is string => Boolean(u));
  if (endpoints.length === 0) {
    throw new Error("createFailoverFetch: at least one RPC URL is required");
  }
  const doFetch = options.baseFetch ?? fetch;

  const failover = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    let lastError: unknown;

    for (let i = 0; i < endpoints.length; i++) {
      const url = endpoints[i];
      const isLast = i === endpoints.length - 1;
      try {
        const res = await doFetch(url, init);
        const text = await res.text();
        const rebuilt = () =>
          new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });

        if (isLast || !isTransientRpcError({ status: res.status, body: text })) {
          return rebuilt();
        }
        options.onFailover?.({ url, status: res.status });
      } catch (err) {
        lastError = err;
        if (isLast) throw err;
        options.onFailover?.({ url, error: err });
      }
    }

    throw lastError ?? new Error("createFailoverFetch: all endpoints failed");
  };

  return failover as unknown as typeof fetch;
}
