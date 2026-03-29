/**
 * In-memory LRU + TTL cache for resolved token metadata.
 *
 * JS Map preserves insertion order. LRU is achieved by deleting and
 * re-inserting on access (moves to end). Eviction removes from the front
 * (least recently used). Expired entries are checked lazily on read.
 */

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
  // Move to end (most recently used)
  store.delete(uri);
  store.set(uri, entry);
  return entry.content;
}

export function setCachedMetadata(
  uri: string,
  resolvedUrl: string | null,
  content: Record<string, unknown> | null,
  isIpfs: boolean
): void {
  // Remove first to ensure re-insertion puts it at the end
  store.delete(uri);

  if (store.size >= MAX_ENTRIES) {
    // Evict least recently used (front of map)
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
  }

  store.set(uri, {
    resolvedUrl,
    content,
    expiresAt: Date.now() + (isIpfs ? IPFS_TTL_MS : HTTP_TTL_MS),
  });
}
