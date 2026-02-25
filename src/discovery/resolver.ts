import { IPFS_GATEWAYS } from "../config/constants.js";
import { isIpfsUri, extractCid } from "../utils/ipfs.js";

/**
 * Resolve any URI to an HTTP-fetchable URL.
 * Returns the URL and gateway index used.
 */
export function resolveUri(
  uri: string,
  gatewayIndex = 0
): { url: string; isIpfs: boolean } {
  if (uri.startsWith("data:")) {
    return { url: uri, isIpfs: false };
  }

  if (isIpfsUri(uri)) {
    const cid = uri.slice(7); // strip "ipfs://"
    const gateway = IPFS_GATEWAYS[gatewayIndex] ?? IPFS_GATEWAYS[0];
    return { url: `${gateway}/${cid}`, isIpfs: true };
  }

  return { url: uri, isIpfs: false };
}

/**
 * Get all fallback URLs for an IPFS URI.
 */
export function getIpfsFallbackUrls(uri: string): string[] {
  if (!isIpfsUri(uri)) return [uri];
  const cid = uri.slice(7);
  return IPFS_GATEWAYS.map((g) => `${g}/${cid}`);
}
