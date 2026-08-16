import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/error.js";
import { readTextCapped, readBinaryCapped } from "../utils/httpBody.js";

const log = createLogger("fetcher");
const DEFAULT_TIMEOUT_MS = 10_000;

const MAX_METADATA_BYTES = 512 * 1024;

function authHeadersFor(url: string): Record<string, string> {
  if (!env.PINATA_JWT) return {};
  try {
    if (new URL(url).hostname === env.PINATA_GATEWAY) {
      return { Authorization: `Bearer ${env.PINATA_JWT}` };
    }
  } catch {
    return {};
  }
  return {};
}

export interface FetchedBinary {
  body: Buffer;
  contentType: string;
}

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
      headers: { Accept: "application/json", ...authHeadersFor(url) },
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

export async function fetchBinary(
  url: string,
  maxBytes: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FetchedBinary | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: authHeadersFor(url),
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

    const { body, truncated } = await readBinaryCapped(res, maxBytes);
    if (truncated) {
      log.warn({ url, maxBytes }, "Binary body exceeded size cap — rejecting");
      return null;
    }
    return { body, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
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
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}
