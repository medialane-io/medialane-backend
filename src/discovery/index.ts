import { getIpfsFallbackUrls, resolveUri } from "./resolver.js";
import { fetchJson } from "./fetcher.js";
import { getCachedMetadata, setCachedMetadata } from "./cache.js";
import { isIpfsUri } from "../utils/ipfs.js";
import { isPrivateOrInsecureUrl, resolvesToPrivateHost } from "../utils/ssrf.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("discovery");

export async function resolveMetadata(
  uri: string
): Promise<Record<string, unknown> | null> {

  const cached = getCachedMetadata(uri);
  if (cached) return cached;

  const isIpfs = isIpfsUri(uri);
  let metadata: Record<string, unknown> | null = null;
  let resolvedUrl: string | null = null;

  if (isIpfs) {

    const urls = getIpfsFallbackUrls(uri);
    for (const url of urls) {
      metadata = await fetchJson(url);
      if (metadata) {
        resolvedUrl = url;
        break;
      }
      log.debug({ url }, "IPFS gateway failed, trying next");
    }
  } else if (uri.startsWith("data:")) {

    resolvedUrl = uri;
    metadata = await fetchJson(uri);
  } else {
    const { url } = resolveUri(uri);

    if (isPrivateOrInsecureUrl(url, false)) {
      log.warn({ url }, "Blocked SSRF attempt in token URI");
      setCachedMetadata(uri, null, null, false);
      return null;
    }

    const hostname = new URL(url).hostname;
    if (await resolvesToPrivateHost(hostname)) {
      log.warn({ url, hostname }, "Blocked SSRF attempt — hostname resolves to a private address");
      setCachedMetadata(uri, null, null, false);
      return null;
    }
    resolvedUrl = url;
    metadata = await fetchJson(url);
  }

  setCachedMetadata(uri, resolvedUrl, metadata, isIpfs);

  return metadata;
}
