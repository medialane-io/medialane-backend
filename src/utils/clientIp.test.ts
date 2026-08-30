import { test, expect } from "bun:test";
import { clientIp } from "./clientIp.js";

function req(headers: Record<string, string>): Request {
  return new Request("https://api.medialane.io/v1/anything", { headers });
}

test("prefers the trusted first-party app header", () => {
  expect(clientIp(req({ "x-medialane-client-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1" })))
    .toBe("203.0.113.9");
});

test("a spoofed leftmost x-forwarded-for entry is ignored", () => {
  expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
});

test("rotating the spoofed prefix cannot change the derived key", () => {
  const a = clientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }));
  const b = clientIp(req({ "x-forwarded-for": "2.2.2.2, 203.0.113.9" }));
  expect(a).toBe(b);
});

test("a single-hop x-forwarded-for is used as-is", () => {
  expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
});

test("falls back to unknown when no forwarding headers are present", () => {
  expect(clientIp(req({}))).toBe("unknown");
});
