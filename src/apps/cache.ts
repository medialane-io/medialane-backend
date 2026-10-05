import { appNameForClient } from "./resolve.js";

export function cachedAppNameForClient(
  lookup: (clientId: string) => Promise<string | null> = appNameForClient,
  options: { ttlMs?: number; now?: () => number } = {},
): (clientId: string) => Promise<string | null> {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: string | null; expiresAt: number }>();
  return async (clientId) => {
    const hit = entries.get(clientId);
    if (hit && hit.expiresAt > now()) return hit.value;
    const value = await lookup(clientId);
    entries.set(clientId, { value, expiresAt: now() + ttlMs });
    return value;
  };
}
