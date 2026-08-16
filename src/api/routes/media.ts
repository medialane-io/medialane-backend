import { Hono } from "hono";
import type { Context } from "hono";
import { resolveFile } from "../../discovery/index.js";
import { isPrivateOrInsecureUrl, resolvesToPrivateHost } from "../../utils/ssrf.js";
import { getCachedFile, setCachedFile } from "../../discovery/fileCache.js";

const media = new Hono();

const CID_PATH_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|b[a-z2-7]{58,})(\/[\w.\-/]*)?$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IPFS_CONTENT_TYPE_PREFIXES = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/svg+xml",
  "video/", "audio/", "model/", "application/octet-stream",
];
const EXTERNAL_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/svg+xml",
  "image/avif", "image/bmp", "image/tiff",
]);

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 300;
const ipCounts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipCounts.get(ip);
  if (!entry || now >= entry.resetAt) {
    ipCounts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}

function requestIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

async function serveFile(
  c: Context,
  cacheKey: string,
  uri: string,
  cacheControl: string,
  allowedContentTypes: string[] | Set<string>,
): Promise<Response> {
  if (!checkRateLimit(requestIp(c))) {
    return c.json({ error: "Too many requests" }, 429);
  }

  let file = getCachedFile(cacheKey);
  if (!file) {
    const result = await resolveFile(uri, MAX_FILE_BYTES);
    if (!result) {
      return c.json({ error: "Failed to fetch file" }, 502);
    }
    const isAllowed = Array.isArray(allowedContentTypes)
      ? allowedContentTypes.some((p) => result.contentType.startsWith(p))
      : allowedContentTypes.has(result.contentType.split(";")[0].trim().toLowerCase());
    if (!isAllowed) {
      return c.json({ error: "Unsupported content type" }, 400);
    }
    file = { body: result.body, contentType: result.contentType };
    setCachedFile(cacheKey, result.body, result.contentType);
  }

  return c.body(new Uint8Array(file.body), 200, {
    "Content-Type": file.contentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cacheControl,
    "Access-Control-Allow-Origin": "*",
  });
}

media.get("/ipfs/*", async (c) => {
  const cidPath = c.req.path.replace(/^.*\/media\/ipfs\//, "");
  if (!CID_PATH_RE.test(cidPath) || cidPath.split("/").includes("..")) {
    return c.json({ error: "Invalid IPFS path" }, 400);
  }

  return serveFile(
    c,
    `ipfs:${cidPath}`,
    `ipfs://${cidPath}`,
    "public, max-age=31536000, s-maxage=31536000, immutable",
    IPFS_CONTENT_TYPE_PREFIXES,
  );
});

media.get("/external", async (c) => {
  const raw = c.req.query("url");
  if (!raw) {
    return c.json({ error: "Missing url" }, 400);
  }
  if (isPrivateOrInsecureUrl(raw)) {
    return c.json({ error: "URL not allowed" }, 400);
  }
  if (await resolvesToPrivateHost(new URL(raw).hostname)) {
    return c.json({ error: "URL not allowed" }, 400);
  }

  return serveFile(
    c,
    `external:${raw}`,
    raw,
    "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
    EXTERNAL_IMAGE_CONTENT_TYPES,
  );
});

export default media;
