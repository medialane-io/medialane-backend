/**
 * SSRF guard utilities.
 *
 * Single source of truth for blocking private/internal IP ranges — import
 * from here instead of defining the regex inline in each route.
 */

const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|::ffff:127\.|fc00:|fd[0-9a-f]{2}:|fe80:)/i;

/** Convert a 32-bit unsigned int to dotted-quad IPv4. */
function intToIpv4(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

/**
 * Browsers and Node's DNS layer accept several non-dotted-quad encodings of
 * IPv4 that the dotted-quad regex above does NOT catch — e.g.
 *   http://2130706433       → 127.0.0.1 (decimal)
 *   http://0x7f000001       → 127.0.0.1 (hex)
 *   http://017700000001     → 127.0.0.1 (octal)
 * Normalize any single-integer hostname into its dotted-quad form so the
 * private-range regex can match. Returns null if the hostname isn't a
 * single integer encoding.
 */
function normalizeNumericHostname(host: string): string | null {
  const trimmed = host.trim();
  // Decimal integer (e.g. "2130706433")
  if (/^\d+$/.test(trimmed)) return intToIpv4(parseInt(trimmed, 10));
  // Hex with 0x prefix (e.g. "0x7f000001")
  if (/^0x[0-9a-f]+$/i.test(trimmed)) return intToIpv4(parseInt(trimmed.slice(2), 16));
  // Octal with leading 0 followed by octal digits only (e.g. "017700000001").
  // Excludes the decimal "0" case (handled above) and dotted-quads.
  if (/^0[0-7]+$/.test(trimmed)) return intToIpv4(parseInt(trimmed, 8));
  return null;
}

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
  // If the hostname is a non-dotted-quad IPv4 encoding (decimal/hex/octal int),
  // normalize first so the private-range regex catches it.
  const checkHost = normalizeNumericHostname(hostname) ?? hostname;
  return PRIVATE_HOST_RE.test(checkHost);
}
