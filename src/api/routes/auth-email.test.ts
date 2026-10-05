import { test, expect } from "bun:test";
import { Hono } from "hono";
import { createAuthEmailRoutes, type AuthEmailDeps } from "./auth-email";
import type { AppEnv } from "../../types/hono.js";
import { env } from "../../config/env.js";
import { issueConfirmToken } from "../../utils/emailConfirmToken.js";

function appWith(deps: Partial<AuthEmailDeps> = {}, client: string | null = "client_IO") {
  const fullDeps: AuthEmailDeps = {
    findLatestCode: async () => null,
    createCode: async () => {},
    claimAttempt: async () => true,
    consumeCode: async () => true,
    sendCode: async () => {},
    checkEmailExists: async () => false,
    createAccountWithEmail: async () => ({ accountId: "acc_TEST", alreadyExisted: false }),
    findAccountIdByEmail: async () => null,
    releaseAbandonedEmail: async () => false,
    createVerifiedAccount: async () => "acc_NEW",
    markEmailVerified: async () => {},
    activateAccount: async () => {},
    accountStatus: async () => "PENDING",
    ...deps,
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (client) {
      c.set("apiKey", {
        id: "key_TEST",
        status: "ACTIVE",
        apiCredits: {
          id: client,
          accountId: "acc_TEST",
          plan: "FREE",
          creditBalance: 0,
          account: { id: "acc_TEST", status: "ACTIVE" },
        },
      });
      c.set("apiCredits", { id: "client_TEST", accountId: "acc_TEST", plan: "FREE", creditBalance: 0 });
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

test("POST /verify-code with the correct code returns a session and no separate email token", async () => {
  const code = await storedCode();
  const app = appWith({ findLatestCode: async () => code });
  const res = await verify(app);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token?: string; accountToken?: string };
  expect(body.token).toBeUndefined();
  expect(typeof body.accountToken).toBe("string");
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

test("POST /verify-code with a wrong code creates nothing", async () => {
  let created = false;
  const code = await storedCode();
  const app = appWith({
    findLatestCode: async () => code,
    createVerifiedAccount: async () => {
      created = true;
      return "acc_NEW";
    },
  });
  const res = await app.request("/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "alice@example.com", code: "000000" }),
  });
  expect(res.status).toBe(400);
  expect(created).toBe(false);
});

test("POST /verify-code with the wrong code returns 400 and spends an attempt", async () => {
  let incremented = false;
  const app = appWith({
    findLatestCode: async () => ({
      id: "1", codeHash: "wrong-hash", attempts: 0, expiresAt: new Date(Date.now() + 60_000), consumedAt: null,
    }),
    claimAttempt: async () => { incremented = true; return true; },
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

test("an account belongs to the client that registered it, so the same address in two clients is two accounts", async () => {
  const asked: Array<{ email: string; client: string }> = [];
  const app = appWith({
    checkEmailExists: async (email, client) => {
      asked.push({ email, client });
      return false;
    },
  });

  await app.request("/exists?email=person@example.com");

  expect(asked).toEqual([{ email: "person@example.com", client: "client_IO" }]);
});

test("a key with no client cannot resolve an account, rather than falling into somebody else's", async () => {
  const app = appWith({}, null);

  const res = await app.request("/exists?email=person@example.com");

  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "unknown_client" });
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

test("POST /request-code sends a code every time it is asked", async () => {
  let sent = 0;
  const app = appWith({ sendCode: async () => { sent += 1; } });
  for (let i = 0; i < 12; i++) {
    const res = await app.request("/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    expect(res.status).toBe(200);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent).toBe(12);
});

test("POST /register-account creates accounts without a volume ceiling", async () => {
  const app = appWith();
  for (let i = 0; i < 12; i++) {
    const res = await app.request("/register-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `person${i}@example.com` }),
    });
    expect(res.status).toBe(200);
  }
});

test("GET /exists answers every lookup", async () => {
  const app = appWith();
  for (let i = 0; i < 70; i++) {
    expect((await app.request(`/exists?email=person${i}@example.com`)).status).toBe(200);
  }
});

test("POST /verify-code activates the account it signs in to", async () => {
  const activated: string[] = [];
  const code = await storedCode();
  const app = appWith({
    findLatestCode: async () => code,
    findAccountIdByEmail: async () => "acc_PENDING",
    activateAccount: async (accountId) => {
      activated.push(accountId);
    },
  });
  expect((await verify(app)).status).toBe(200);
  expect(activated).toEqual(["acc_PENDING"]);
});

test("POST /verify-code refuses when the atomic attempt claim fails, even if the stored count looked fine", async () => {
  let created = false;
  const code = await storedCode();
  const app = appWith({
    findLatestCode: async () => code,
    claimAttempt: async () => false,
    createVerifiedAccount: async () => {
      created = true;
      return "acc_NEW";
    },
  });
  const res = await verify(app);
  expect(res.status).toBe(429);
  expect(created).toBe(false);
});

test("POST /verify-code lets a correct code sign in only once", async () => {
  let created = 0;
  const code = await storedCode();
  const app = appWith({
    findLatestCode: async () => code,
    consumeCode: async () => false,
    createVerifiedAccount: async () => {
      created += 1;
      return "acc_NEW";
    },
  });
  const res = await verify(app);
  expect(res.status).toBe(400);
  expect(created).toBe(0);
});

const tokenFor = (over: Partial<{ accountId: string; email: string; expiresAt: Date }> = {}) =>
  issueConfirmToken(env.SIWS_SECRET, {
    accountId: "acc_TEST",
    email: "alice@example.com",
    expiresAt: new Date(Date.now() + 86_400_000),
    ...over,
  });

const confirm = (app: ReturnType<typeof appWith>, token: string) =>
  app.request("/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

test("POST /confirm with a good link verifies the email and activates the account, and signs no one in", async () => {
  const calls: string[] = [];
  const app = appWith({
    findAccountIdByEmail: async () => "acc_TEST",
    markEmailVerified: async (email) => void calls.push(`verified:${email}`),
    activateAccount: async (id) => void calls.push(`activated:${id}`),
  });
  const res = await confirm(app, tokenFor());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, email: "alice@example.com" });
  expect(calls).toEqual(["verified:alice@example.com", "activated:acc_TEST"]);
});

test("POST /confirm twice is harmless", async () => {
  const app = appWith({ findAccountIdByEmail: async () => "acc_TEST" });
  const token = tokenFor();
  expect((await confirm(app, token)).status).toBe(200);
  expect((await confirm(app, token)).status).toBe(200);
});

test("POST /confirm refuses an expired link and changes nothing", async () => {
  const calls: string[] = [];
  const app = appWith({
    findAccountIdByEmail: async () => "acc_TEST",
    markEmailVerified: async () => void calls.push("verified"),
  });
  const res = await confirm(app, tokenFor({ expiresAt: new Date(Date.now() - 1000) }));
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toBe("invalid_or_expired");
  expect(calls).toEqual([]);
});

test("POST /confirm refuses a link for an account that has already been closed", async () => {
  const app = appWith({ findAccountIdByEmail: async () => "acc_TEST", accountStatus: async () => "INACTIVE" });
  expect((await confirm(app, tokenFor())).status).toBe(400);
});

test("POST /confirm refuses a link whose email is no longer on the account", async () => {
  const gone = appWith({ findAccountIdByEmail: async () => null });
  expect((await confirm(gone, tokenFor())).status).toBe(400);
  const other = appWith({ findAccountIdByEmail: async () => "acc_SOMEONE_ELSE" });
  expect((await confirm(other, tokenFor())).status).toBe(400);
});

test("POST /confirm refuses a token that is not a confirm token", async () => {
  const app = appWith({ findAccountIdByEmail: async () => "acc_TEST" });
  expect((await confirm(app, "not-a-token")).status).toBe(400);
});

test("POST /confirm needs a client like the other email routes", async () => {
  const app = appWith({}, null);
  expect((await confirm(app, tokenFor())).status).toBe(400);
});
