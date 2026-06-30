// SSRF guard golden tests. The webhook delivery path (P0-3 fix) and the
// metadata resolver both depend on this rejecting private/internal ranges.
// If this regresses, internal infra becomes reachable from the indexer.
import { describe, expect, test } from "bun:test";
import { isPrivateOrInsecureUrl, isPrivateIp, resolvesToPrivateHost } from "./ssrf.js";

describe("isPrivateOrInsecureUrl — should REJECT (true)", () => {
  test.each([
    ["http://example.com", true],          // non-https when requireHttps default
    ["https://localhost/x", true],
    ["https://127.0.0.1/x", true],
    ["https://10.0.0.5/x", true],
    ["https://172.16.0.1/x", true],
    ["https://172.31.255.254/x", true],
    ["https://192.168.1.1/x", true],
    ["https://169.254.169.254/latest/meta-data/", true], // AWS IMDS
    ["https://[::1]/x", true],
    ["https://[fc00::1]/x", true],
    ["https://[fe80::1]/x", true],
    ["not-a-url", true],                   // unparseable → reject
  ])("rejects %s", (url, expected) => {
    expect(isPrivateOrInsecureUrl(url)).toBe(expected);
  });
});

describe("isPrivateOrInsecureUrl — should ACCEPT (false)", () => {
  test.each([
    "https://example.com/x",
    "https://api.medialane.io/webhook",
    "https://1.1.1.1/x",                   // public IP
    "https://172.15.0.1/x",                // just outside 172.16-31 range
    "https://172.32.0.1/x",                // just outside 172.16-31 range
  ])("accepts %s", (url) => {
    expect(isPrivateOrInsecureUrl(url)).toBe(false);
  });
});

describe("isPrivateOrInsecureUrl — integer/hex IPv4 encodings (P2-2)", () => {
  test.each([
    "https://2130706433/x",         // decimal → 127.0.0.1
    "https://0x7f000001/x",         // hex → 127.0.0.1
    "https://017700000001/x",       // octal → 127.0.0.1
    "https://3232235521/x",         // decimal → 192.168.0.1
    "https://0xa9fea9fe/x",         // hex → 169.254.169.254 (AWS IMDS!)
  ])("rejects encoded private %s", (url) => {
    expect(isPrivateOrInsecureUrl(url)).toBe(true);
  });

  test.each([
    "https://16843009/x",           // decimal → 1.1.1.1 (public)
    "https://0x01010101/x",         // hex → 1.1.1.1 (public)
  ])("still accepts encoded public %s", (url) => {
    expect(isPrivateOrInsecureUrl(url)).toBe(false);
  });
});

describe("isPrivateOrInsecureUrl — requireHttps=false (token URI path)", () => {
  test("allows http:// for token URIs", () => {
    expect(isPrivateOrInsecureUrl("http://example.com", false)).toBe(false);
  });

  test("still blocks private IPs even with http allowed", () => {
    expect(isPrivateOrInsecureUrl("http://127.0.0.1", false)).toBe(true);
    expect(isPrivateOrInsecureUrl("http://169.254.169.254", false)).toBe(true);
  });
});

// isPrivateIp — the numeric range checker resolvesToPrivateHost relies on.
// Exercises ranges isPrivateOrInsecureUrl's string-pattern check above can't
// see at all once DNS resolution is involved (2026-06-30 audit fix).
describe("isPrivateIp — IPv4", () => {
  test.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1",
    "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
  ])("flags %s as private", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  test.each(["1.1.1.1", "8.8.8.8", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0"])(
    "leaves %s public",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});

describe("isPrivateIp — IPv6", () => {
  test.each([
    "::", "::1", "fc00::1", "fdff::1", "fe80::1", "FE80::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254",
  ])("flags %s as private", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  test.each(["2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:1.1.1.1"])(
    "leaves %s public",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );

  test("rejects garbage as unparseable", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
  });
});

describe("resolvesToPrivateHost", () => {
  test("a literal private IPv4 needs no DNS lookup", async () => {
    expect(await resolvesToPrivateHost("127.0.0.1")).toBe(true);
  });

  test("a literal private IPv6 needs no DNS lookup", async () => {
    expect(await resolvesToPrivateHost("[fe80::1]")).toBe(true);
  });

  test("an unresolvable hostname fails closed (rejected)", async () => {
    expect(await resolvesToPrivateHost("this-domain-should-not-exist.invalid")).toBe(true);
  });

  test("a known-public hostname resolves and is accepted", async () => {
    // one.one.one.one is Cloudflare's own resolver test domain — always public.
    expect(await resolvesToPrivateHost("one.one.one.one")).toBe(false);
  });
});
