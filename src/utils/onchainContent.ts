import { env } from "../config/env.js";

const IMAGE_TYPES = new Set(["image/svg+xml", "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function isInlineContent(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

export function storedTokenUri(uri: string | null | undefined): string | null {
  if (!uri || isInlineContent(uri)) return null;
  return uri;
}

export function onchainImageUrl(chain: string, contractAddress: string, tokenId: string): string {
  return `${env.PUBLIC_API_URL}/media/${chain.toLowerCase()}/${contractAddress}/${tokenId}/image`;
}

export function storedImage(image: unknown, chain: string, contractAddress: string, tokenId: string): string | null {
  if (typeof image !== "string" || !image) return null;
  return isInlineContent(image) ? onchainImageUrl(chain, contractAddress, tokenId) : image;
}

export function decodeImageDataUri(uri: string): { contentType: string; bytes: ArrayBuffer } | null {
  if (!isInlineContent(uri)) return null;
  const comma = uri.indexOf(",");
  if (comma === -1) return null;
  const header = uri.slice(5, comma);
  const [mime, ...params] = header.split(";");
  const contentType = (mime ?? "").trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) return null;
  const payload = uri.slice(comma + 1);
  try {
    const bytes = params.includes("base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf-8");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    return { contentType, bytes: new Uint8Array(bytes).buffer };
  } catch {
    return null;
  }
}
