

const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|::ffff:127\.|fc00:|fd[0-9a-f]{2}:|fe80:)/i;

function intToIpv4(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

function normalizeNumericHostname(host: string): string | null {
  const trimmed = host.trim();

  if (/^\d+$/.test(trimmed)) return intToIpv4(parseInt(trimmed, 10));

  if (/^0x[0-9a-f]+$/i.test(trimmed)) return intToIpv4(parseInt(trimmed.slice(2), 16));

  if (/^0[0-7]+$/.test(trimmed)) return intToIpv4(parseInt(trimmed, 8));
  return null;
}

export function isPrivateOrInsecureUrl(raw: string, requireHttps = true): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return true;
  }
  if (requireHttps && parsed.protocol !== "https:") return true;

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  const checkHost = normalizeNumericHostname(hostname) ?? hostname;
  return PRIVATE_HOST_RE.test(checkHost);
}

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

function isPrivateIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function expandIpv6(rawIp: string): number[] | null {
  let ip = rawIp;

  let embeddedV4: number[] | null = null;
  const v4Tail = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Tail && ip.includes(":")) {
    embeddedV4 = parseIpv4(v4Tail[1]);
    if (!embeddedV4) return null;
    ip = ip.slice(0, ip.length - v4Tail[1].length) + "0:0";
  }

  const sides = ip.split("::");
  if (sides.length > 2) return null;

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

function isPrivateIpv6(bytes: number[]): boolean {
  const isZero = bytes.every((b) => b === 0);
  if (isZero) return true;
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;

  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4(bytes.slice(12));
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isPrivateIpv4(v4);
  const v6 = expandIpv6(ip.replace(/^\[|\]$/g, ""));
  if (v6) return isPrivateIpv6(v6);
  return true;
}

export async function resolvesToPrivateHost(hostname: string): Promise<boolean> {

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
    return true;
  }
}
