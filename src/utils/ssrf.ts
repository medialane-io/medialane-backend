import { isPrivateHost, isPrivateOrInsecureUrl } from "@medialane/sdk";

/**
 * SSRF guards for outbound fetches.
 *
 * The address and URL checks live in @medialane/sdk. They used to live here as
 * well, and the two copies had drifted: each caught encodings the other missed.
 * Security logic maintained in two places only stays correct by luck, so this
 * module keeps the one thing that genuinely cannot be shared — DNS resolution,
 * which needs a Node resolver that an isomorphic package cannot import.
 */

export { isPrivateHost, isPrivateOrInsecureUrl };

const IPV4_SHAPE = /^\d{1,3}(\.\d{1,3}){3}$/;
// Dots are allowed: v4-mapped forms like ::ffff:1.1.1.1 are valid IPv6.
const IPV6_SHAPE = /^[0-9a-f:.]+(%[0-9a-z]+)?$/i;

/**
 * Whether an address that is *expected to be an IP* is private.
 *
 * Distinct from isPrivateHost, and deliberately so: this is for values that
 * came back from a resolver, where anything unparseable means something went
 * wrong and the safe answer is to refuse. isPrivateHost answers false for a
 * name that simply is not an IP, which is right for a hostname and wrong here.
 */
export function isPrivateIp(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, "");
  const looksLikeIp = IPV4_SHAPE.test(value) || (value.includes(":") && IPV6_SHAPE.test(value));
  if (!looksLikeIp) return true;
  return isPrivateHost(value);
}

/**
 * Whether a hostname resolves to any address a server must not fetch.
 *
 * A URL check alone is not enough: an attacker controls their own DNS, so a
 * perfectly public-looking name can resolve to 127.0.0.1 or a metadata
 * endpoint. Fails closed — an unresolvable name, or one with no addresses, is
 * treated as private rather than waved through.
 */
export async function resolvesToPrivateHost(hostname: string): Promise<boolean> {
  const literal = hostname.replace(/^\[|\]$/g, "");

  // An IP literal has nothing to resolve; judge it directly.
  if (isPrivateHost(literal)) return true;

  try {
    const { lookup } = await import("node:dns/promises");
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) return true;
    return records.some((record) => isPrivateIp(record.address));
  } catch {
    return true;
  }
}
