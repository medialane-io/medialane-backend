import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { requestIdMiddleware } from "./requestId.js";
import { corsMiddleware } from "./cors.js";

function app() {
  const a = new Hono();
  a.use("*", corsMiddleware);
  a.use("*", requestIdMiddleware);
  a.get("/", (c) => c.text("ok"));
  return a;
}

describe("request id", () => {
  test("a plain id from the caller is kept", async () => {
    const res = await app().request("/", { headers: { "x-request-id": "req-123.abc_9" } });
    expect(res.headers.get("x-request-id")).toBe("req-123.abc_9");
  });

  test("an id with odd characters or excessive length is replaced", async () => {
    for (const bad of ["a b", "x".repeat(200), "id;drop"]) {
      const res = await app().request("/", { headers: { "x-request-id": bad } });
      expect(res.headers.get("x-request-id")).not.toBe(bad);
      expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe("cors for browser payment flows", () => {
  test("x-payment is an allowed request header and the credit headers are readable", async () => {
    const res = await app().request("/", {
      method: "OPTIONS",
      headers: {
        Origin: "https://medialane.io",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-payment",
      },
    });
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-payment");
    const real = await app().request("/", { headers: { Origin: "https://medialane.io" } });
    expect(real.headers.get("access-control-expose-headers")).toContain("X-Credits-Remaining");
  });
});
