import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createIdentityAuth } from "./identityAuth";
import { issueToken } from "../../utils/siwsToken.js";
import type { AppEnv } from "../../types/hono.js";

function appWith(isInactive: (chain: string, address: string) => Promise<boolean> = async () => false) {
  const app = new Hono<AppEnv>();
  app.use("*", createIdentityAuth({ isInactive }));
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

test("identityAuth refuses a wallet whose account is inactive", async () => {
  const token = issueToken("STARKNET", "0x0123");
  const res = await appWith(async () => true).request("/", { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(403);
});

test("identityAuth lets a pending account's wallet through", async () => {
  const seen: string[] = [];
  const token = issueToken("STARKNET", "0x0123");
  const res = await appWith(async (_chain, address) => {
    seen.push(address);
    return false;
  }).request("/", { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect(seen).toHaveLength(1);
});
