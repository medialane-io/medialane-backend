const TRANSIENT_BODY_RE =
  /"code"\s*:\s*-32001|"code"\s*:\s*-32603|unable to complete|rate.?limit|too many|throttl|exceed.*quota|temporarily unavailable|service unavailable|overload|gateway.*time|upstream.*time|backend.*error/i;

export const POLICY_REFUSAL_CODES: readonly number[] = [-32003, -32005, -32600];

export function isPolicyRefusal(input: { body?: unknown }): boolean {
  let body = input.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return false;
    }
  }
  const err = (body as { error?: { code?: unknown } } | null | undefined)?.error;
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "number" && POLICY_REFUSAL_CODES.includes(code);
}

export function isTransientRpcError(input: { status?: number; body?: unknown }): boolean {
  const { status, body } = input;

  if (isPolicyRefusal({ body })) return false;

  if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  if (body == null) return false;

  if (typeof body === "object") {
    const err = (body as { error?: { code?: unknown; message?: unknown } }).error;
    if (!err || typeof err !== "object") return false;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") {
      if (code === 429) return true;
      if (code >= -32099 && code <= -32000) return true;
      if (code === -32603) return true;
    }
    const message = (err as { message?: unknown }).message;
    return typeof message === "string" ? TRANSIENT_BODY_RE.test(message) : false;
  }

  return TRANSIENT_BODY_RE.test(String(body));
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
