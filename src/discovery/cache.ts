const IPFS_TTL_MS = 7 * 24 * 3600 * 1000;
const HTTP_TTL_MS = 24 * 3600 * 1000;
const MAX_ENTRIES = 10_000;

interface CacheEntry {
  resolvedUrl: string | null;
  content: Record<string, unknown> | null;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

export function getCachedMetadata(uri: string): Record<string, unknown> | null {
  const entry = store.get(uri);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(uri);
    return null;
  }
  return entry.content;
}

export function setCachedMetadata(
  uri: string,
  resolvedUrl: string | null,
  content: Record<string, unknown> | null,
  isIpfs: boolean
): void {
  if (store.size >= MAX_ENTRIES) {
    const evictCount = Math.floor(MAX_ENTRIES * 0.2);
    const keys = store.keys();
    for (let i = 0; i < evictCount; i++) {
      const { value, done } = keys.next();
      if (done) break;
      store.delete(value);
    }
  }
  store.set(uri, {
    resolvedUrl,
    content,
    expiresAt: Date.now() + (isIpfs ? IPFS_TTL_MS : HTTP_TTL_MS),
  });
}
