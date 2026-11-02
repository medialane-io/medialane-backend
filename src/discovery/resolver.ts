import { IPFS_GATEWAYS } from "../config/constants.js";
import { env } from "../config/env.js";
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

/**
 * Gateways to read IPFS files from, in order: the configured dedicated gateway (fast, but it may
 * refuse files that are not pinned to the account), then the public ones.
 */
export function ipfsGatewayUrls(configuredGateway: string): string[] {
  const host = configuredGateway.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const dedicated = `https://${host}/ipfs`;
  return IPFS_GATEWAYS.includes(dedicated) ? [...IPFS_GATEWAYS] : [dedicated, ...IPFS_GATEWAYS];
}

export function getIpfsFallbackUrls(uri: string): string[] {
  if (!isIpfsUri(uri)) return [uri];
  const cid = uri.slice(7);
  return ipfsGatewayUrls(env.PINATA_GATEWAY).map((g) => `${g}/${cid}`);
}
