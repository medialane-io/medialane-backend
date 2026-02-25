import { createLogger } from "../utils/logger.js";

const log = createLogger("fetcher");
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetch a URL with a timeout, returning parsed JSON or null.
 */
export async function fetchJson(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Record<string, unknown> | null> {
  if (url.startsWith("data:application/json")) {
    return decodeDataUri(url);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      log.warn({ url, status: res.status }, "Non-OK response");
      return null;
    }

    const json = await res.json();
    return json as Record<string, unknown>;
  } catch (err: any) {
    if (err.name === "AbortError") {
      log.warn({ url }, "Request timed out");
    } else {
      log.warn({ url, err: err.message }, "Fetch error");
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeDataUri(uri: string): Record<string, unknown> | null {
  try {
    const base64Part = uri.split(",")[1];
    if (!base64Part) return null;
    const decoded = Buffer.from(base64Part, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}
