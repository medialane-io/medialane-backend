const IPFS_TTL_MS = 7 * 24 * 3600 * 1000;
const HTTP_TTL_MS = 24 * 3600 * 1000;
const MAX_ENTRIES = 10_000;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

interface CacheEntry {
  resolvedUrl: string | null;
  content: Record<string, unknown> | null;
  bytes: number;
  expiresAt: number;
}

export function createMetadataCache(maxBytes = MAX_CACHE_BYTES, maxEntries = MAX_ENTRIES) {
  const store = new Map<string, CacheEntry>();
  let totalBytes = 0;

  const remove = (uri: string) => {
    const entry = store.get(uri);
    if (!entry) return;
    store.delete(uri);
    totalBytes -= entry.bytes;
  };

  return {
    get(uri: string): Record<string, unknown> | null {
      const entry = store.get(uri);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        remove(uri);
        return null;
      }

      store.delete(uri);
      store.set(uri, entry);
      return entry.content;
    },

    set(uri: string, resolvedUrl: string | null, content: Record<string, unknown> | null, isIpfs: boolean): void {
      remove(uri);

      const bytes = content ? Buffer.byteLength(JSON.stringify(content)) : 0;
      if (bytes > maxBytes) return;

      while (store.size > 0 && (store.size >= maxEntries || totalBytes + bytes > maxBytes)) {
        remove(store.keys().next().value!);
      }

      store.set(uri, {
        resolvedUrl,
        content,
        bytes,
        expiresAt: Date.now() + (isIpfs ? IPFS_TTL_MS : HTTP_TTL_MS),
      });
      totalBytes += bytes;
    },

    get bytes(): number {
      return totalBytes;
    },
  };
}

const cache = createMetadataCache();

export function getCachedMetadata(uri: string): Record<string, unknown> | null {
  return cache.get(uri);
}

export function setCachedMetadata(
  uri: string,
  resolvedUrl: string | null,
  content: Record<string, unknown> | null,
  isIpfs: boolean
): void {
  cache.set(uri, resolvedUrl, content, isIpfs);
}
