import { test, expect } from "bun:test";
import { Hono } from "hono";
import { identityAuth } from "./identityAuth";
import { issueToken } from "../../utils/siwsToken.js";
import type { AppEnv } from "../../types/hono.js";

function appWith() {
  const app = new Hono<AppEnv>();
  app.use("*", identityAuth);
  app.get("/", (c) => c.json({ walletAddress: c.get("walletAddress") }));
  return app;
}

test("identityAuth rejects a request with no Authorization header", async () => {
  const res = await appWith().request("/");
  expect(res.status).toBe(401);
});

test("identityAuth rejects a malformed Authorization header", async () => {
  const res = await appWith().request("/", { headers: { Authorization: "not-bearer-shaped" } });
  expect(res.status).toBe(401);
});

test("identityAuth accepts a valid SIWS token and stamps walletAddress", async () => {
  const token = issueToken("STARKNET", "0x0123");
  const res = await appWith().request("/", { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = await res.json() as { walletAddress: string };
  expect(body.walletAddress).toBeDefined();
});

test("identityAuth rejects an invalid/expired SIWS token", async () => {
  const res = await appWith().request("/", { headers: { Authorization: "Bearer siws_garbage" } });
  expect(res.status).toBe(401);
});

test("identityAuth rejects a bearer token that isn't SIWS-shaped (no other auth path exists)", async () => {
  const res = await appWith().request("/", { headers: { Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.fake.jwt" } });
  expect(res.status).toBe(401);
});
