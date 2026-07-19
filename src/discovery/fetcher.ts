import { createLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/error.js";
import { readTextCapped } from "../utils/httpBody.js";

const log = createLogger("fetcher");
const DEFAULT_TIMEOUT_MS = 10_000;
// Metadata JSON is small (name/description/attributes/image URI). Cap the
// response so a hostile token_uri host can't OOM the indexer with a huge body
// — a truncated object won't parse, so we reject rather than partial-parse.
const MAX_METADATA_BYTES = 512 * 1024; // 512 KB, matches the upload-route cap

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
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      log.warn({ url, status: res.status }, "Redirect blocked");
      return null;
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
    const base64Part = uri.split(",")[1];
    if (!base64Part) return null;
    const decoded = Buffer.from(base64Part, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}
