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

// ---------------------------------------------------------------------------
// DNS-resolution-based guard.
//
// `isPrivateOrInsecureUrl` above only pattern-matches the literal hostname
// string — it cannot catch a public-looking domain (e.g. evil.example) whose
// DNS A/AAAA record points at an internal address. `resolvesToPrivateHost`
// performs the actual resolution and checks every returned address by numeric
// range, closing that gap. Residual limitation: this is a point-in-time check,
// not IP-pinned — a DNS record that changes between this check and the actual
// fetch() (rebinding) is not caught. Full protection needs a custom fetch
// dispatcher that connects to the resolved+validated IP directly; not done
// here, flagged as a follow-up.
// ---------------------------------------------------------------------------

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

/** Numeric range check for IPv4 — RFC-1918, loopback, link-local (incl. cloud
 *  metadata 169.254.169.254), CGNAT, multicast/reserved, broadcast. */
function isPrivateIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  return false;
}

/** Expand a (possibly compressed) IPv6 literal into 16 bytes. Null if unparseable. */
function expandIpv6(rawIp: string): number[] | null {
  let ip = rawIp;

  // Mixed notation (e.g. "::ffff:127.0.0.1") — extract the trailing IPv4 part
  // and substitute two placeholder hex groups so the rest of the parser sees
  // a uniform colon-separated address; patch the real bytes back in after.
  let embeddedV4: number[] | null = null;
  const v4Tail = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail && ip.includes(":")) {
    embeddedV4 = parseIpv4(v4Tail[1]);
    if (!embeddedV4) return null;
    ip = ip.slice(0, ip.length - v4Tail[1].length) + "0:0";
  }

  const sides = ip.split("::");
  if (sides.length > 2) return null; // more than one "::" is invalid

  const head = sides[0] ? sides[0].split(":").filter(Boolean) : [];
  const tail = sides.length === 2 && sides[1] ? sides[1].split(":").filter(Boolean) : [];

  let groups: string[];
  if (sides.length === 1) {
    groups = head;
    if (groups.length !== 8) return null;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }

  if (embeddedV4) {
    bytes[12] = embeddedV4[0];
    bytes[13] = embeddedV4[1];
    bytes[14] = embeddedV4[2];
    bytes[15] = embeddedV4[3];
  }

  return bytes;
}

/** Numeric range check for IPv6 — loopback, ULA (fc00::/7), link-local
 *  (fe80::/10), and IPv4-mapped (::ffff:0:0/96, checked via the embedded v4). */
function isPrivateIpv6(bytes: number[]): boolean {
  const isZero = bytes.every((b) => b === 0);
  if (isZero) return true; // :: (unspecified)
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1 loopback
  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  // ::ffff:0:0/96 IPv4-mapped — validate the embedded IPv4 address too.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(bytes.slice(12));
  }
  return false;
}

/** Returns true if `ip` (already-resolved literal, v4 or v6) is a private/internal address. */
export function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isPrivateIpv4(v4);
  const v6 = expandIpv6(ip.replace(/^\[|\]$/g, ""));
  if (v6) return isPrivateIpv6(v6);
  return true; // unparseable as either family → reject, don't risk a bypass
}

/**
 * Resolves `hostname` via DNS and returns true if resolution fails OR any
 * resolved address is private/internal. This is the check that catches a
 * public domain whose DNS record points at an internal IP — `isPrivateOrInsecureUrl`
 * alone cannot see this since it only inspects the literal hostname string.
 */
export async function resolvesToPrivateHost(hostname: string): Promise<boolean> {
  // A literal IP doesn't need DNS resolution — check it directly.
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (parseIpv4(literal) || expandIpv6(literal)) {
    return isPrivateIp(literal);
  }
  try {
    const { lookup } = await import("node:dns/promises");
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) return true;
    return records.some((r) => isPrivateIp(r.address));
  } catch {
    return true; // resolution failure → reject, don't fail open
  }
}
