/**
 * Shared validation for the two claim-a-handle flows: usernames
 * (`routes/username-claims.ts`) and collection slugs
 * (`routes/collection-slug-claims.ts`). Both had their own copy of this
 * regex + reserved-word set; the sets had already silently diverged
 * ("collection" was reserved for slugs but not usernames) — exactly the
 * failure mode a single shared list prevents (2026-06-30 audit follow-up).
 */

// 3–20 chars, lowercase letters/numbers/underscores/hyphens, cannot start or end with _ or -
export const SLUG_LIKE_REGEX = /^[a-z0-9][a-z0-9_-]{1,18}[a-z0-9]$|^[a-z0-9]{3}$/;

export const RESERVED_HANDLES = new Set([
  "admin", "api", "www", "medialane", "creator", "creators", "account",
  "portfolio", "support", "docs", "about", "discover", "marketplace",
  "collections", "collection", "activities", "launchpad", "create", "search",
  "settings", "help", "legal", "terms", "privacy", "contact",
  "team", "dao", "blog", "news", "status", "security",
]);

/** `noun` is interpolated into the returned error messages ("username" / "slug"). */
export function validateSlugLike(value: string, noun: string): string | null {
  if (!SLUG_LIKE_REGEX.test(value)) {
    return `${noun[0].toUpperCase()}${noun.slice(1)} must be 3–20 characters and contain only lowercase letters, numbers, underscores, and hyphens. Cannot start or end with _ or -.`;
  }
  if (RESERVED_HANDLES.has(value)) {
    return `That ${noun} is reserved.`;
  }
  return null;
}
