import { IPFS_GATEWAYS } from "../config/constants.js";
import { isIpfsUri, extractCid } from "../utils/ipfs.js";

export function resolveUri(
  uri: string,
  gatewayIndex = 0
): { url: string; isIpfs: boolean } {
  if (uri.startsWith("data:")) {
    return { url: uri, isIpfs: false };
  }

  if (isIpfsUri(uri)) {
    const cid = uri.slice(7);
    const gateway = IPFS_GATEWAYS[gatewayIndex] ?? IPFS_GATEWAYS[0];
    return { url: `${gateway}/${cid}`, isIpfs: true };
  }

  return { url: uri, isIpfs: false };
}

export function getIpfsFallbackUrls(uri: string): string[] {
  if (!isIpfsUri(uri)) return [uri];
  const cid = uri.slice(7);
  return IPFS_GATEWAYS.map((g) => `${g}/${cid}`);
}
