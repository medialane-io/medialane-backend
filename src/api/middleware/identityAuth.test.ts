import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createIdentityAuth, type IdentityAuthDeps } from "./identityAuth";
import { issueToken } from "../../utils/siwsToken.js";
import type { AppEnv } from "../../types/hono.js";

type SessionResult = Awaited<ReturnType<IdentityAuthDeps["session"]>>;

function appWith(
  isInactive: (appId: string | null, chain: string, address: string) => Promise<boolean> = async () => false,
  appId: string | null = "app-A",
  session: (raw: string) => Promise<SessionResult> = async () => ({ verdict: "invalid" }),
  options: { walletOptional?: boolean } = {},
) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (appId) c.set("appId", appId);
    await next();
  });
  app.use("*", createIdentityAuth({ isInactive, session }, options));
  app.get("/", (c) => c.json({ walletAddress: c.get("walletAddress"), sessionAccountId: c.get("sessionAccountId") }));
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
  const res = await appWith(async (_client, _chain, address) => {
    seen.push(address);
    return false;
  }).request("/", { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect(seen).toHaveLength(1);
});

test("identityAuth checks the wallet's account in the caller's app only", async () => {
  const token = issueToken("STARKNET", "0x0123");
  const asked: Array<string | null> = [];
  const inactiveOnlyInB = async (appId: string | null) => {
    asked.push(appId);
    return appId === "app-B";
  };
  const onA = await appWith(inactiveOnlyInB, "app-A").request("/", { headers: { Authorization: `Bearer ${token}` } });
  const onB = await appWith(inactiveOnlyInB, "app-B").request("/", { headers: { Authorization: `Bearer ${token}` } });
  expect(onA.status).toBe(200);
  expect(onB.status).toBe(403);
  expect(asked).toEqual(["app-A", "app-B"]);
});

const SESSION = { "x-account-session": "acct-session" };
const live = async () => ({ verdict: "ok" as const, accountId: "acc_1", walletAddress: "0xabc" });

test("identityAuth accepts an account session and stamps the account's wallet", async () => {
  const res = await appWith(undefined, "app-A", live).request("/", { headers: SESSION });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ walletAddress: "0xabc", sessionAccountId: "acc_1" });
});

test("identityAuth refuses the session of an inactive account", async () => {
  const res = await appWith(undefined, "app-A", async () => ({ verdict: "inactive" })).request("/", { headers: SESSION });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "Account is not active", code: "account_inactive" });
});

test("identityAuth refuses an invalid session", async () => {
  for (const verdict of ["invalid"] as const) {
    const res = await appWith(undefined, "app-A", async () => ({ verdict })).request("/", { headers: SESSION });
    expect(res.status).toBe(401);
  }
});

test("identityAuth asks for a wallet when the session's account has none", async () => {
  const noWallet = async () => ({ verdict: "ok" as const, accountId: "acc_1", walletAddress: null });
  const res = await appWith(undefined, "app-A", noWallet).request("/", { headers: SESSION });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "This account has no wallet yet", code: "wallet_required" });
});

test("identityAuth lets a session without a wallet through where the wallet is optional", async () => {
  const noWallet = async () => ({ verdict: "ok" as const, accountId: "acc_1", walletAddress: null });
  const res = await appWith(undefined, "app-A", noWallet, { walletOptional: true }).request("/", { headers: SESSION });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ sessionAccountId: "acc_1" });
});

test("identityAuth uses the wallet token when both a token and a session are sent", async () => {
  const token = issueToken("STARKNET", "0x0123");
  const res = await appWith(undefined, "app-A", live).request("/", {
    headers: { ...SESSION, Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { walletAddress: string; sessionAccountId?: string };
  expect(body.walletAddress).not.toBe("0xabc");
  expect(body.sessionAccountId).toBeUndefined();
});
