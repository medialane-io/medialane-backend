/**
 * SSRF guard utilities.
 *
 * Single source of truth for blocking private/internal IP ranges — import
 * from here instead of defining the regex inline in each route.
 */

const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|::ffff:127\.|fc00:|fd[0-9a-f]{2}:|fe80:)/i;

/**
 * Returns true when `raw` should be rejected as an SSRF target.
 *
 * @param raw        - The URL string to validate.
 * @param requireHttps - When true (default) any non-https scheme is rejected.
 *                       Pass false for contexts that also allow http (e.g. resolve endpoint).
 */
export function isPrivateOrInsecureUrl(raw: string, requireHttps = true): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return true; // unparseable → reject
  }
  if (requireHttps && parsed.protocol !== "https:") return true;
  // Strip surrounding brackets from IPv6 literals before matching (e.g. [::1] → ::1)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  return PRIVATE_HOST_RE.test(hostname);
}
