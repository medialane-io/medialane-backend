import { IPFS_GATEWAYS } from "../config/constants.js";

export function ipfsToHttp(uri: string, gatewayIndex = 0): string {
  if (uri.startsWith("ipfs://")) {
    const cid = uri.slice(7);
    const gateway = IPFS_GATEWAYS[gatewayIndex] ?? IPFS_GATEWAYS[0];
    return `${gateway}/${cid}`;
  }
  if (uri.startsWith("https://") || uri.startsWith("http://")) {
    return uri;
  }
  if (uri.startsWith("data:")) {
    return uri;
  }

  return `${IPFS_GATEWAYS[0]}/${uri}`;
}

export function extractCid(uri: string): string | null {
  if (uri.startsWith("ipfs://")) {
    return uri.slice(7).split("/")[0];
  }
  const match = uri.match(/\/ipfs\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

export function isIpfsUri(uri: string): boolean {
  return uri.startsWith("ipfs://");
}
