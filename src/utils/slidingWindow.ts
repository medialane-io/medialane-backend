/**
 * Creates an in-memory sliding-window rate limiter.
 * Returns a function that accepts a key and returns true if the request is allowed.
 * Note: resets on process restart — use only for burst protection, not persistent quotas.
 */
export function createSlidingWindow(max: number, windowMs: number): (key: string) => boolean {
  const store = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const ts = (store.get(key) ?? []).filter(t => now - t < windowMs);
    if (ts.length >= max) return false;
    ts.push(now);
    store.set(key, ts);
    return true;
  };
}
