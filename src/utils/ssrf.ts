import { isPrivateHost, isPrivateOrInsecureUrl } from "@medialane/sdk";

export { isPrivateHost, isPrivateOrInsecureUrl };

const IPV4_SHAPE = /^\d{1,3}(\.\d{1,3}){3}$/;

const IPV6_SHAPE = /^[0-9a-f:.]+(%[0-9a-z]+)?$/i;

export function isPrivateIp(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, "");
  const looksLikeIp = IPV4_SHAPE.test(value) || (value.includes(":") && IPV6_SHAPE.test(value));
  if (!looksLikeIp) return true;
  return isPrivateHost(value);
}

export async function resolvesToPrivateHost(hostname: string): Promise<boolean> {
  const literal = hostname.replace(/^\[|\]$/g, "");

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
