
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
