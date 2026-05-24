// SSRF guard golden tests. The webhook delivery path (P0-3 fix) and the
// metadata resolver both depend on this rejecting private/internal ranges.
// If this regresses, internal infra becomes reachable from the indexer.
import { describe, expect, test } from "bun:test";
import { isPrivateOrInsecureUrl } from "./ssrf.js";

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
