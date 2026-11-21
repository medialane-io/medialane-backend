import { IPFS_PUBLIC_GATEWAYS } from "@medialane/sdk";
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
    const gateway = IPFS_PUBLIC_GATEWAYS[gatewayIndex] ?? IPFS_PUBLIC_GATEWAYS[0];
    return { url: `${gateway}/${cid}`, isIpfs: true };
  }

  return { url: uri, isIpfs: false };
}

export function ipfsGatewayUrls(configuredGateway: string): string[] {
  const host = configuredGateway.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const dedicated = `https://${host}/ipfs`;
  return IPFS_PUBLIC_GATEWAYS.includes(dedicated) ? [...IPFS_PUBLIC_GATEWAYS] : [dedicated, ...IPFS_PUBLIC_GATEWAYS];
}

export function getIpfsFallbackUrls(uri: string): string[] {
  if (!isIpfsUri(uri)) return [uri];
  const cid = uri.slice(7);
  return ipfsGatewayUrls(env.PINATA_GATEWAY).map((g) => `${g}/${cid}`);
}
