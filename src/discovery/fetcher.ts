import { createLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/error.js";
import { readTextCapped } from "../utils/httpBody.js";
import { isPrivateOrInsecureUrl, resolvesToPrivateHost } from "../utils/ssrf.js";
import { MAX_METADATA_BYTES } from "../config/constants.js";

const log = createLogger("fetcher");
const DEFAULT_TIMEOUT_MS = 10_000;

const MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 5000;

export function retryDelayMs(retryAfter: string | null, now = Date.now()): number {
  if (retryAfter === null) return DEFAULT_RETRY_DELAY_MS;
  const seconds = Number(retryAfter);
  const ms = Number.isFinite(seconds) && retryAfter.trim() !== "" ? seconds * 1000 : Date.parse(retryAfter) - now;
  if (!Number.isFinite(ms)) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(Math.max(ms, 0), MAX_RETRY_DELAY_MS);
}

export async function fetchJson(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowRedirect = true,
  rateLimitRetries = 0,
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
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!allowRedirect || !location) {
        log.warn({ url, status: res.status }, "Redirect blocked");
        return null;
      }

      const target = new URL(location, url).toString();
      if (isPrivateOrInsecureUrl(target, false) || (await resolvesToPrivateHost(new URL(target).hostname))) {
        log.warn({ url, target }, "Blocked SSRF attempt via redirect");
        return null;
      }

      log.debug({ url, target }, "Following single-hop redirect");
      return fetchJson(target, timeoutMs, false);
    }

    if (res.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
      const delay = retryDelayMs(res.headers.get("retry-after"));
      log.warn({ url, delay }, "Rate limited, retrying");
      clearTimeout(timer);
      await res.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchJson(url, timeoutMs, allowRedirect, rateLimitRetries + 1);
    }

    if (!res.ok) {
      log.warn({ url, status: res.status }, "Non-OK response");
      return null;
    }

    const { text, truncated } = await readTextCapped(res, MAX_METADATA_BYTES);
    if (truncated) {
      log.warn({ url, maxBytes: MAX_METADATA_BYTES }, "Metadata body exceeded size cap — rejecting");
      return null;
    }
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      log.warn({ url }, "Request timed out");
    } else {
      log.warn({ url, err: toErrorMessage(err) }, "Fetch error");
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeDataUri(uri: string): Record<string, unknown> | null {
  try {

    const commaIndex = uri.indexOf(",");
    if (commaIndex === -1) return null;
    const header = uri.slice(0, commaIndex);
    const payload = uri.slice(commaIndex + 1);

    const decoded = header.includes(";base64")
      ? Buffer.from(payload, "base64").toString("utf-8")
      : decodeURIComponent(payload);
    try {
      return JSON.parse(decoded);
    } catch {
      return JSON.parse(escapeControlCharactersInStrings(decoded));
    }
  } catch {
    return null;
  }
}

function escapeControlCharactersInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}
