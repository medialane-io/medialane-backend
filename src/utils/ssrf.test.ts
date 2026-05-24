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

describe("isPrivateOrInsecureUrl — requireHttps=false (token URI path)", () => {
  test("allows http:// for token URIs", () => {
    expect(isPrivateOrInsecureUrl("http://example.com", false)).toBe(false);
  });

  test("still blocks private IPs even with http allowed", () => {
    expect(isPrivateOrInsecureUrl("http://127.0.0.1", false)).toBe(true);
    expect(isPrivateOrInsecureUrl("http://169.254.169.254", false)).toBe(true);
  });
});
