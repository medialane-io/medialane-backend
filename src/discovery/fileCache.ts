const TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

interface FileCacheEntry {
  body: Buffer;
  contentType: string;
  size: number;
  expiresAt: number;
}

const store = new Map<string, FileCacheEntry>();
let totalBytes = 0;

export function getCachedFile(key: string): { body: Buffer; contentType: string } | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    totalBytes -= entry.size;
    return null;
  }

  store.delete(key);
  store.set(key, entry);
  return { body: entry.body, contentType: entry.contentType };
}

export function setCachedFile(key: string, body: Buffer, contentType: string): void {
  store.delete(key);

  while (totalBytes + body.length > MAX_TOTAL_BYTES && store.size > 0) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = store.get(oldestKey);
    store.delete(oldestKey);
    if (oldest) totalBytes -= oldest.size;
  }

  if (body.length > MAX_TOTAL_BYTES) return;

  store.set(key, { body, contentType, size: body.length, expiresAt: Date.now() + TTL_MS });
  totalBytes += body.length;
}
