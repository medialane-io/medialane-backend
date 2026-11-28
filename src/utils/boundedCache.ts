export interface BoundedCacheOptions<V> {
  maxSize: number;
  ttlMs: number;
  sizeOf: (value: V) => number;
  now?: () => number;
}

export interface BoundedCache<V> {
  load(key: string, loader: () => Promise<V>): Promise<V>;
}

export function createBoundedCache<V>(options: BoundedCacheOptions<V>): BoundedCache<V> {
  const { maxSize, ttlMs, sizeOf } = options;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: V; size: number; expiresAt: number }>();
  const pending = new Map<string, Promise<V>>();
  let total = 0;

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    total -= entry.size;
    entries.delete(key);
  };

  const store = (key: string, value: V) => {
    const size = Math.max(sizeOf(value), 1);
    if (size > maxSize) return;
    remove(key);
    entries.set(key, { value, size, expiresAt: now() + ttlMs });
    total += size;
    for (const oldest of entries.keys()) {
      if (total <= maxSize) break;
      remove(oldest);
    }
  };

  return {
    load(key, loader) {
      const entry = entries.get(key);
      if (entry && entry.expiresAt > now()) {
        entries.delete(key);
        entries.set(key, entry);
        return Promise.resolve(entry.value);
      }
      remove(key);

      const inFlight = pending.get(key);
      if (inFlight) return inFlight;

      const loading = loader()
        .then((value) => {
          store(key, value);
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, loading);
      return loading;
    },
  };
}
