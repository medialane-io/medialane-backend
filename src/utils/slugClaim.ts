

export const SLUG_LIKE_REGEX = /^[a-z0-9][a-z0-9_-]{1,18}[a-z0-9]$|^[a-z0-9]{3}$/;

export const RESERVED_HANDLES = new Set([
  "admin", "api", "www", "medialane", "creator", "creators", "account",
  "portfolio", "support", "docs", "about", "discover", "marketplace",
  "collections", "collection", "activities", "launchpad", "create", "search",
  "settings", "help", "legal", "terms", "privacy", "contact",
  "team", "dao", "blog", "news", "status", "security",
]);

export function validateSlugLike(value: string, noun: string): string | null {
  if (!SLUG_LIKE_REGEX.test(value)) {
    return `${noun[0].toUpperCase()}${noun.slice(1)} must be 3–20 characters and contain only lowercase letters, numbers, underscores, and hyphens. Cannot start or end with _ or -.`;
  }
  if (RESERVED_HANDLES.has(value)) {
    return `That ${noun} is reserved.`;
  }
  return null;
}
