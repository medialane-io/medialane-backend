import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createAuthEmailRoutes, type AuthEmailDeps } from "./auth-email";
import type { AppEnv } from "../../types/hono.js";

function appWith(deps: Partial<AuthEmailDeps> = {}) {
  const fullDeps: AuthEmailDeps = {
    findLatestCode: async () => null,
    createCode: async () => {},
    incrementAttempts: async () => {},
    consumeCode: async () => {},
    sendCode: async () => {},
    checkRateLimit: async () => true,
    checkEmailExists: async () => false,
    createAccountWithEmail: async () => ({ accountId: "acc_TEST", alreadyExisted: false }),
    checkAccountCreateRateLimit: async () => true,
    findAccountIdByEmail: async () => null,
    ...deps,
  };
  const app = new Hono<AppEnv>();
  app.route("/", createAuthEmailRoutes(fullDeps));
  return app;
}

test("POST /request-code with a valid email returns 200 and sends a code", async () => {
  const sent: { to: string | null; code: string | null } = { to: null, code: null };
  const app = appWith({
    sendCode: async (to, code) => { sent.to = to; sent.code = code; },
  });
  const res = await app.request("/request-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com" }),
  });
  expect(res.status).toBe(200);
  expect(sent.to).toBe("alice@example.com");
  expect(sent.code).toMatch(/^\d{6}$/);
});

test("POST /request-code responds without waiting for sendCode to settle", async () => {
  let sendCodeResolved = false;
  const app = appWith({
    sendCode: () =>
      new Promise((resolve) => {
        setTimeout(() => { sendCodeResolved = true; resolve(); }, 50);
      }),
  });
  const res = await app.request("/request-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com" }),
  });
  expect(res.status).toBe(200);
  expect(sendCodeResolved).toBe(false);
});

test("POST /request-code with an invalid email format returns 400", async () => {
  const app = appWith();
  const res = await app.request("/request-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  expect(res.status).toBe(400);
});

test("POST /request-code is rate-limited", async () => {
  const app = appWith({ checkRateLimit: async () => false });
  const res = await app.request("/request-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com" }),
  });
  expect(res.status).toBe(429);
});

test("POST /verify-code with the correct code returns 200 and a token", async () => {
  const { createHmac } = await import("crypto");
  const { env } = await import("../../config/env.js");
  const codeHash = createHmac("sha256", env.SIWS_SECRET).update("482913").digest("hex");
  const app = appWith({
    findLatestCode: async () => ({
      id: "1", codeHash, attempts: 0, expiresAt: new Date(Date.now() + 60_000), consumedAt: null,
    }),
  });
  const res = await app.request("/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com", code: "482913" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { token: string };
  expect(body.token.startsWith("email_verified_")).toBe(true);
});

test("POST /verify-code with the wrong code returns 400 and increments attempts", async () => {
  let incremented = false;
  const app = appWith({
    findLatestCode: async () => ({
      id: "1", codeHash: "wrong-hash", attempts: 0, expiresAt: new Date(Date.now() + 60_000), consumedAt: null,
    }),
    incrementAttempts: async () => { incremented = true; },
  });
  const res = await app.request("/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com", code: "000000" }),
  });
  expect(res.status).toBe(400);
  expect(incremented).toBe(true);
});

test("POST /verify-code with an expired code returns 400", async () => {
  const app = appWith({
    findLatestCode: async () => ({
      id: "1", codeHash: "any", attempts: 0, expiresAt: new Date(Date.now() - 1000), consumedAt: null,
    }),
  });
  const res = await app.request("/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com", code: "482913" }),
  });
  expect(res.status).toBe(400);
});

test("POST /verify-code with no matching code returns 400", async () => {
  const app = appWith({ findLatestCode: async () => null });
  const res = await app.request("/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com", code: "482913" }),
  });
  expect(res.status).toBe(400);
});

test("POST /verify-code with a code that hit the attempt cap returns 429", async () => {
  const app = appWith({
    findLatestCode: async () => ({
      id: "1", codeHash: "any", attempts: 5, expiresAt: new Date(Date.now() + 60_000), consumedAt: null,
    }),
  });
  const res = await app.request("/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com", code: "482913" }),
  });
  expect(res.status).toBe(429);
});

test("GET /exists returns { exists: true } when checkEmailExists resolves true", async () => {
  const app = appWith({ checkEmailExists: async () => true });
  const res = await app.request("/exists?email=alice@example.com");
  expect(res.status).toBe(200);
  const body = await res.json() as { exists: boolean };
  expect(body.exists).toBe(true);
});

test("GET /exists returns { exists: false } when checkEmailExists resolves false", async () => {
  const app = appWith({ checkEmailExists: async () => false });
  const res = await app.request("/exists?email=alice@example.com");
  expect(res.status).toBe(200);
  const body = await res.json() as { exists: boolean };
  expect(body.exists).toBe(false);
});

test("GET /exists with a missing email query param returns 400", async () => {
  const app = appWith();
  const res = await app.request("/exists");
  expect(res.status).toBe(400);
});

test("GET /exists with an invalid email format returns 400", async () => {
  const app = appWith();
  const res = await app.request("/exists?email=not-an-email");
  expect(res.status).toBe(400);
});

test("POST /register-account creates an account and returns an accountToken", async () => {
  const app = appWith({
    createAccountWithEmail: async (email) => {
      expect(email).toBe("alice@example.com");
      return { accountId: "acc_ABC123", alreadyExisted: false };
    },
  });
  const res = await app.request("/register-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { accountToken: string };
  expect(body.accountToken.startsWith("account_session_")).toBe(true);
});

test("POST /register-account with an invalid email format returns 400", async () => {
  const app = appWith();
  const res = await app.request("/register-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  expect(res.status).toBe(400);
});

test("POST /register-account is rate-limited per IP", async () => {
  const app = appWith({ checkAccountCreateRateLimit: async () => false });
  const res = await app.request("/register-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com" }),
  });
  expect(res.status).toBe(429);
});

test("POST /register-account still succeeds (idempotently) if the email was registered a moment ago by a concurrent request", async () => {
  const app = appWith({
    createAccountWithEmail: async () => ({ accountId: "acc_EXISTING", alreadyExisted: true }),
  });
  const res = await app.request("/register-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { accountToken: string };
  expect(body.accountToken.startsWith("account_session_")).toBe(true);
});
