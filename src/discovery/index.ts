import { getIpfsFallbackUrls, resolveUri } from "./resolver.js";
import { fetchJson } from "./fetcher.js";
import { getCachedMetadata, setCachedMetadata } from "./cache.js";
import { isIpfsUri } from "../utils/ipfs.js";
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
  const cached = await getCachedMetadata(uri);
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
    resolvedUrl = url;
    metadata = await fetchJson(url);
  }

  // Cache result (even null, to avoid repeated failed fetches)
  await setCachedMetadata(uri, resolvedUrl, metadata, isIpfs);

  return metadata;
}
