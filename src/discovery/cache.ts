

const IPFS_TTL_MS = 7 * 24 * 3600 * 1000;
const HTTP_TTL_MS = 24 * 3600 * 1000;
/** A failed read is remembered briefly, so an unreachable file does not hold up every request. */
const FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 10_000;

interface CacheEntry {
  resolvedUrl: string | null;
  content: Record<string, unknown> | null;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

/** The cached read for `uri`, or undefined when there is none. `content` is null for a remembered failure. */
export function getCachedMetadata(uri: string): { content: Record<string, unknown> | null } | undefined {
  const entry = store.get(uri);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(uri);
    return undefined;
  }

  store.delete(uri);
  store.set(uri, entry);
  return { content: entry.content };
}

export function setCachedMetadata(
  uri: string,
  resolvedUrl: string | null,
  content: Record<string, unknown> | null,
  isIpfs: boolean
): void {

  store.delete(uri);

  if (store.size >= MAX_ENTRIES) {

    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
  }

  store.set(uri, {
    resolvedUrl,
    content,
    expiresAt: Date.now() + (content === null ? FAILURE_TTL_MS : isIpfs ? IPFS_TTL_MS : HTTP_TTL_MS),
  });
}
