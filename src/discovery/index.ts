import { getIpfsFallbackUrls, resolveUri } from "./resolver.js";
import { fetchJson } from "./fetcher.js";
import { getCachedMetadata, setCachedMetadata } from "./cache.js";
import { isIpfsUri } from "../utils/ipfs.js";
import { isPrivateOrInsecureUrl, resolvesToPrivateHost } from "../utils/ssrf.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("discovery");

/**
 * Resolve a token URI to its metadata JSON.
 * Uses caching and IPFS gateway fallbacks.
 */
export async function resolveMetadata(
  uri: string
): Promise<Record<string, unknown> | null> {
  // Check cache
  const cached = getCachedMetadata(uri);
  if (cached) return cached;

  const isIpfs = isIpfsUri(uri);
  let metadata: Record<string, unknown> | null = null;
  let resolvedUrl: string | null = null;

  if (isIpfs) {
    // Try each gateway in order
    const urls = getIpfsFallbackUrls(uri);
    for (const url of urls) {
      metadata = await fetchJson(url);
      if (metadata) {
        resolvedUrl = url;
        break;
      }
      log.debug({ url }, "IPFS gateway failed, trying next");
    }
  } else {
    const { url } = resolveUri(uri);
    // SSRF guard, layer 1: block private/internal IPs and cloud metadata
    // ranges by literal hostname/IP pattern. requireHttps=false allows
    // http:// for legacy on-chain token URIs while still blocking all
    // RFC-1918, loopback, link-local, and IMDS literal forms.
    if (isPrivateOrInsecureUrl(url, false)) {
      log.warn({ url }, "Blocked SSRF attempt in token URI");
      setCachedMetadata(uri, null, null, false);
      return null;
    }
    // SSRF guard, layer 2: a public-looking domain can still have a DNS
    // record pointing at an internal address — layer 1 only inspects the
    // hostname string, never resolves it. Resolve here and re-check by IP.
    const hostname = new URL(url).hostname;
    if (await resolvesToPrivateHost(hostname)) {
      log.warn({ url, hostname }, "Blocked SSRF attempt — hostname resolves to a private address");
      setCachedMetadata(uri, null, null, false);
      return null;
    }
    resolvedUrl = url;
    metadata = await fetchJson(url);
  }

  // Cache result (even null, to avoid repeated failed fetches)
  setCachedMetadata(uri, resolvedUrl, metadata, isIpfs);

  return metadata;
}
