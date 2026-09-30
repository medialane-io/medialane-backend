import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createAuthEmailRoutes, type AuthEmailDeps } from "./auth-email";
import type { AppEnv } from "../../types/hono.js";

function appWith(deps: Partial<AuthEmailDeps> = {}, tenant: string | null = "tnt_medialane_io") {
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
    checkEmailExistsRateLimit: async () => true,
    findAccountIdByEmail: async () => null,
    releaseAbandonedEmail: async () => false,
    findWaitingWallets: async () => [],
    createVerifiedAccount: async () => "acc_NEW",
    markEmailVerified: async () => {},
    ...deps,
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (tenant) {
      c.set("apiKey", {
        id: "key_TEST",
        status: "ACTIVE",
        tenantId: tenant,
        apiClient: {
          id: "client_TEST",
          accountId: "acc_TEST",
          plan: "FREE",
          creditBalance: 0,
          account: { id: "acc_TEST", status: "ACTIVE" },
        },
      });
      c.set("apiClient", { id: "client_TEST", accountId: "acc_TEST", plan: "FREE", creditBalance: 0 });
    }
    return next();
  });
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
  const codeHash = createHmac("sha256", env.SIWS_SECRET).update("otp-code-v1.482913").digest("hex");
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

test("POST /verify-code returns an accountToken when the verified email belongs to an existing account", async () => {
  const { createHmac } = await import("crypto");
  const { env } = await import("../../config/env.js");
  const codeHash = createHmac("sha256", env.SIWS_SECRET).update("otp-code-v1.482913").digest("hex");
  const app = appWith({
    findLatestCode: async () => ({
      id: "1", codeHash, attempts: 0, expiresAt: new Date(Date.now() + 60_000), consumedAt: null,
    }),
    findAccountIdByEmail: async () => "acc_EXISTING",
  });
  const res = await app.request("/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com", code: "482913" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { token: string; accountToken?: string };
  expect(body.accountToken?.startsWith("account_session_")).toBe(true);
});

async function storedCode() {
  const { createHmac } = await import("crypto");
  const { env } = await import("../../config/env.js");
  const codeHash = createHmac("sha256", env.SIWS_SECRET).update("otp-code-v1.482913").digest("hex");
  return { id: "1", codeHash, attempts: 0, expiresAt: new Date(Date.now() + 60_000), consumedAt: null };
}

const verify = (app: ReturnType<typeof appWith>, email = "alice@example.com") =>
  app.request("/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code: "482913" }),
  });

test("POST /verify-code creates a verified account when the email is new", async () => {
  const created: string[] = [];
  const code = await storedCode();
  const app = appWith({
    findLatestCode: async () => code,
    createVerifiedAccount: async (email) => {
      created.push(email);
      return "acc_NEW";
    },
  });
  const res = await verify(app);
  expect(res.status).toBe(200);
  expect(created).toEqual(["alice@example.com"]);
  const body = (await res.json()) as { accountToken?: string };
  expect(typeof body.accountToken).toBe("string");
});

test("POST /verify-code marks an existing account's email verified", async () => {
  const marked: string[] = [];
  const code = await storedCode();
  const app = appWith({
    findLatestCode: async () => code,
    findAccountIdByEmail: async () => "acc_OLD",
    markEmailVerified: async (email) => {
      marked.push(email);
    },
  });
  expect((await verify(app)).status).toBe(200);
  expect(marked).toEqual(["alice@example.com"]);
});

test("POST /verify-code lists the wallets waiting for the proven email", async () => {
  const code = await storedCode();
  const app = appWith({
    findLatestCode: async () => code,
    findWaitingWallets: async (email) => (email === "alice@example.com" ? ["0xabc"] : []),
  });
  const body = (await (await verify(app)).json()) as { waitingWallets: string[] };
  expect(body.waitingWallets).toEqual(["0xabc"]);
});

test("POST /verify-code with a wrong code lists nothing and creates nothing", async () => {
  let created = false;
  const code = await storedCode();
  const app = appWith({
    findLatestCode: async () => code,
    createVerifiedAccount: async () => {
      created = true;
      return "acc_NEW";
    },
    findWaitingWallets: async () => ["0xabc"],
  });
  const res = await app.request("/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com", code: "000000" }),
  });
  expect(res.status).toBe(400);
  expect(created).toBe(false);
  expect(JSON.stringify(await res.json()).includes("0xabc")).toBe(false);
});

test("GET /exists says when a wallet is waiting for the email", async () => {
  const app = appWith({ findWaitingWallets: async () => ["0xabc"] });
  const res = await app.request("/exists?email=alice@example.com");
  expect(await res.json()).toEqual({ exists: false, walletWaiting: true });
});

test("GET /exists matches the email in any letter case", async () => {
  const seen: string[] = [];
  const app = appWith({
    findWaitingWallets: async (email) => {
      seen.push(email);
      return [];
    },
  });
  await app.request("/exists?email=Alice@Example.com");
  expect(seen).toEqual(["alice@example.com"]);
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

test("POST /register-account refuses to mint a session for an account that already exists", async () => {
  const app = appWith({
    createAccountWithEmail: async () => ({ accountId: "acc_EXISTING", alreadyExisted: true }),
  });
  const res = await app.request("/register-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "victim@example.com" }),
  });
  expect(res.status).toBe(409);
  const body = await res.json() as { error: string; accountToken?: string };
  expect(body.error).toBe("ACCOUNT_EXISTS");
  expect(body.accountToken).toBeUndefined();
});

test("POST /register-account does not leak whether the existing account was ever verified", async () => {
  const app = appWith({
    createAccountWithEmail: async () => ({ accountId: "acc_EXISTING", alreadyExisted: true }),
  });
  const res = await app.request("/register-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "victim@example.com" }),
  });
  const body = await res.json() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["error", "message"]);
});

test("GET /exists returns 429 once the per-IP lookup rate limit is exceeded", async () => {
  const app = appWith({
    checkEmailExists: async () => true,
    checkEmailExistsRateLimit: async () => false,
  });
  const res = await app.request("/exists?email=alice@example.com");
  expect(res.status).toBe(429);
});

test("GET /exists does not reveal existence when rate limited", async () => {
  const app = appWith({
    checkEmailExists: async () => true,
    checkEmailExistsRateLimit: async () => false,
  });
  const res = await app.request("/exists?email=alice@example.com");
  const body = await res.json() as { exists?: boolean };
  expect(body.exists).toBeUndefined();
});

test("an account belongs to the app that created it, so the same address in two apps is two accounts", async () => {
  const asked: Array<{ email: string; tenant: string }> = [];
  const app = appWith({
    checkEmailExists: async (email, tenant) => {
      asked.push({ email, tenant });
      return false;
    },
  });

  await app.request("/exists?email=person@example.com");

  expect(asked).toEqual([{ email: "person@example.com", tenant: "tnt_medialane_io" }]);
});

test("a key with no app cannot resolve an account, rather than falling into somebody else's", async () => {
  const app = appWith({}, null);

  const res = await app.request("/exists?email=person@example.com");

  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "unknown_app" });
});

test("a rotated client IP cannot outrun the per-API-client code ceiling", async () => {
  const seen: Array<string | null> = [];
  let sent = 0;
  const app = appWith({
    checkRateLimit: async (_email, _ip, apiClientId) => {
      seen.push(apiClientId);
      return seen.length <= 2;
    },
    sendCode: async () => {
      sent += 1;
    },
  });

  const request = (ip: string) =>
    app.request("/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-medialane-client-ip": ip },
      body: JSON.stringify({ email: "spam@example.com" }),
    });

  expect((await request("1.1.1.1")).status).toBe(200);
  expect((await request("2.2.2.2")).status).toBe(200);
  expect((await request("3.3.3.3")).status).toBe(429);

  expect(seen).toEqual(["client_TEST", "client_TEST", "client_TEST"]);
  expect(sent).toBe(2);
});

test("account creation is capped per API client as well as per IP", async () => {
  const seen: Array<string | null> = [];
  const app = appWith({
    checkAccountCreateRateLimit: async (_ip, apiClientId) => {
      seen.push(apiClientId);
      return false;
    },
  });

  const res = await app.request("/register-account", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-medialane-client-ip": "9.9.9.9" },
    body: JSON.stringify({ email: "new@example.com" }),
  });

  expect(res.status).toBe(429);
  expect(seen).toEqual(["client_TEST"]);
});

test("GET /exists looks the account up with the email as typed", async () => {
  const seen: string[] = [];
  const app = appWith({
    checkEmailExists: async (email) => {
      seen.push(email);
      return true;
    },
  });
  await app.request("/exists?email=Alice@Example.com");
  expect(seen).toEqual(["Alice@Example.com"]);
});

test("POST /verify-code looks the account up and marks it verified with the email as typed", async () => {
  const looked: string[] = [];
  const marked: string[] = [];
  const code = await storedCode();
  const app = appWith({
    findLatestCode: async () => code,
    findAccountIdByEmail: async (email) => {
      looked.push(email);
      return "acc_OLD";
    },
    markEmailVerified: async (email) => {
      marked.push(email);
    },
  });
  expect((await verify(app, "Alice@Example.com")).status).toBe(200);
  expect(looked).toEqual(["Alice@Example.com"]);
  expect(marked).toEqual(["Alice@Example.com"]);
});

test("POST /verify-code finds waiting wallets with the email in lower case", async () => {
  const seen: string[] = [];
  const code = await storedCode();
  const app = appWith({
    findLatestCode: async () => code,
    findWaitingWallets: async (email) => {
      seen.push(email);
      return [];
    },
  });
  await verify(app, "Alice@Example.com");
  expect(seen).toEqual(["alice@example.com"]);
});
