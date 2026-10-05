import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createHmac, timingSafeEqual, randomInt } from "crypto";
import prisma from "../../db/client.js";
import { env } from "../../config/env.js";
import { sendVerificationCode } from "../../utils/mailer.js";
import { issueAccountSessionToken } from "../../utils/accountSessionToken.js";
import { releaseAbandonedEmail } from "../../utils/emailClaim.js";
import { verifyConfirmToken } from "../../utils/emailConfirmToken.js";
import { verifyAndActivate } from "../../utils/confirmEmail.js";
import { createLogger } from "../../utils/logger.js";
import { IDENTITY_SCHEME, emailValues, normalizeIdentityValue } from "../../utils/identity.js";
import type { AppEnv } from "../../types/hono.js";
import { callerApiCreditsId } from "../../utils/caller.js";

import { ensureAccountForIdentity } from "../../utils/account.js";

const log = createLogger("routes:auth-email");

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface StoredCode {
  id: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface AuthEmailDeps {
  findLatestCode: (email: string) => Promise<StoredCode | null>;
  createCode: (email: string, codeHash: string, expiresAt: Date) => Promise<void>;
  claimAttempt: (id: string) => Promise<boolean>;
  consumeCode: (id: string) => Promise<boolean>;
  sendCode: (to: string, code: string, apiCreditsId: string | null) => Promise<void>;
  checkEmailExists: (email: string, apiCreditsId: string) => Promise<boolean>;
  createAccountWithEmail: (email: string, apiCreditsId: string) => Promise<{ accountId: string; alreadyExisted: boolean }>;
  findAccountIdByEmail: (email: string, apiCreditsId: string) => Promise<string | null>;
  releaseAbandonedEmail: (email: string, apiCreditsId: string) => Promise<boolean>;
  createVerifiedAccount: (email: string, apiCreditsId: string) => Promise<string>;
  markEmailVerified: (email: string, apiCreditsId: string) => Promise<void>;
  activateAccount: (accountId: string) => Promise<void>;
  accountStatus: (accountId: string) => Promise<"PENDING" | "ACTIVE" | "INACTIVE" | null>;
}

const CODE_HASH_DOMAIN = "otp-code-v1";

function hashCode(code: string): string {
  return createHmac("sha256", env.SIWS_SECRET).update(`${CODE_HASH_DOMAIN}.${code}`).digest("hex");
}

const requestCodeSchema = z.object({ email: z.string().email() });
const verifyCodeSchema = z.object({ email: z.string().email(), code: z.string().length(6) });
const existsQuerySchema = z.object({ email: z.string().email() });
const registerAccountSchema = z.object({ email: z.string().email() });
const confirmSchema = z.object({ token: z.string().min(1).max(2048) });

const INVALID_LINK = { error: "invalid_or_expired", message: "This link is invalid or has expired." } as const;



const NO_CLIENT = {
  error: "unknown_client",
  message: "This API key has no client, so an account cannot be resolved for it.",
} as const;

export function createAuthEmailRoutes(deps: AuthEmailDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/request-code", zValidator("json", requestCodeSchema), async (c) => {
    const { email } = c.req.valid("json");
    await issueVerificationCodeWithDeps(deps, email, callerApiCreditsId(c));
    return c.json({ ok: true });
  });

  app.post("/verify-code", zValidator("json", verifyCodeSchema), async (c) => {
    const apiCreditsId = callerApiCreditsId(c);
    if (!apiCreditsId) return c.json(NO_CLIENT, 400);

    const { email, code } = c.req.valid("json");
    const stored = await deps.findLatestCode(email);

    if (!stored || stored.consumedAt || stored.expiresAt < new Date()) {
      return c.json({ error: "Invalid or expired code" }, 400);
    }
    if (stored.attempts >= MAX_ATTEMPTS) {
      return c.json({ error: "Too many attempts — request a new code" }, 429);
    }

    if (!(await deps.claimAttempt(stored.id))) {
      return c.json({ error: "Too many attempts — request a new code" }, 429);
    }

    const provided = hashCode(code);
    const expected = stored.codeHash;
    const matches =
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));

    if (!matches) {
      return c.json({ error: "Incorrect code" }, 400);
    }

    if (!(await deps.consumeCode(stored.id))) {
      return c.json({ error: "Invalid or expired code" }, 400);
    }

    await deps.releaseAbandonedEmail(email, apiCreditsId);

    let accountId = await deps.findAccountIdByEmail(email, apiCreditsId);
    if (accountId) {
      await verifyAndActivate(deps, accountId, email, apiCreditsId);
    } else {
      accountId = await deps.createVerifiedAccount(email, apiCreditsId);
    }
    return c.json({ accountToken: issueAccountSessionToken(accountId) });
  });

  app.get("/exists", zValidator("query", existsQuerySchema), async (c) => {
    const apiCreditsId = callerApiCreditsId(c);
    if (!apiCreditsId) return c.json(NO_CLIENT, 400);

    const { email } = c.req.valid("query");
    const exists = await deps.checkEmailExists(email, apiCreditsId);
    return c.json({ exists });
  });

  app.post("/register-account", zValidator("json", registerAccountSchema), async (c) => {
    const { email } = c.req.valid("json");
    const apiCreditsId = callerApiCreditsId(c);
    if (!apiCreditsId) return c.json(NO_CLIENT, 400);

    const { accountId, alreadyExisted } = await deps.createAccountWithEmail(email, apiCreditsId);
    if (alreadyExisted) {
      return c.json({ error: "ACCOUNT_EXISTS", message: "Verify this address with a code to sign in." }, 409);
    }
    return c.json({ accountToken: issueAccountSessionToken(accountId) });
  });

  app.post("/confirm", zValidator("json", confirmSchema), async (c) => {
    const apiCreditsId = callerApiCreditsId(c);
    if (!apiCreditsId) return c.json(NO_CLIENT, 400);

    const claims = verifyConfirmToken(env.SIWS_SECRET, c.req.valid("json").token);
    if (!claims) return c.json(INVALID_LINK, 400);

    const status = await deps.accountStatus(claims.accountId);
    const owner = await deps.findAccountIdByEmail(claims.email, apiCreditsId);
    if (!status || status === "INACTIVE" || owner !== claims.accountId) return c.json(INVALID_LINK, 400);

    await verifyAndActivate(deps, claims.accountId, claims.email, apiCreditsId);
    return c.json({ ok: true, email: claims.email });
  });

  return app;
}

const productionDeps: AuthEmailDeps = {
  findLatestCode: (email) =>
    prisma.emailVerificationCode.findFirst({
      where: { email: normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email) },
      orderBy: { createdAt: "desc" },
    }),
  createCode: async (email, codeHash, expiresAt) => {
    await prisma.emailVerificationCode.create({
      data: { email: normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email), codeHash, expiresAt },
    });
  },
  claimAttempt: async (id) => {
    const { count } = await prisma.emailVerificationCode.updateMany({
      where: { id, attempts: { lt: MAX_ATTEMPTS }, consumedAt: null },
      data: { attempts: { increment: 1 } },
    });
    return count === 1;
  },
  consumeCode: async (id) => {
    const { count } = await prisma.emailVerificationCode.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  },
  sendCode: sendVerificationCode,
  checkEmailExists: async (email, apiCreditsId) => {
    const identity = await prisma.identity.findFirst({
      where: { apiCreditsId, scheme: IDENTITY_SCHEME.EMAIL, value: { in: emailValues(email) } },
      select: { id: true },
    });
    return identity !== null;
  },
  createAccountWithEmail: async (email, apiCreditsId) => {
    const { accountId, created } = await ensureAccountForIdentity(IDENTITY_SCHEME.EMAIL, email, apiCreditsId);
    if (created) await prisma.account.update({ where: { id: accountId }, data: { status: "PENDING" } });
    return { accountId, alreadyExisted: !created };
  },
  activateAccount: async (accountId) => {
    await prisma.account.updateMany({
      where: { id: accountId, status: "PENDING" },
      data: { status: "ACTIVE", sessionsValidFrom: new Date() },
    });
  },
  accountStatus: async (accountId) => {
    const account = await prisma.account.findUnique({ where: { id: accountId }, select: { status: true } });
    return account?.status ?? null;
  },
  releaseAbandonedEmail,
  createVerifiedAccount: async (email, apiCreditsId) => {
    const { accountId } = await ensureAccountForIdentity(IDENTITY_SCHEME.EMAIL, email, apiCreditsId);
    await prisma.identity.updateMany({
      where: { scheme: IDENTITY_SCHEME.EMAIL, value: normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email), apiCreditsId: apiCreditsId },
      data: { verifiedAt: new Date() },
    });
    return accountId;
  },
  markEmailVerified: async (email, apiCreditsId) => {
    await prisma.identity.updateMany({
      where: {
        scheme: IDENTITY_SCHEME.EMAIL,
        value: { in: emailValues(email) },
        apiCreditsId: apiCreditsId,
        verifiedAt: null,
      },
      data: { verifiedAt: new Date() },
    });
  },
  findAccountIdByEmail: async (email, apiCreditsId) => {
    const identity = await prisma.identity.findFirst({
      where: { apiCreditsId, scheme: IDENTITY_SCHEME.EMAIL, value: { in: emailValues(email) } },
      select: { accountId: true },
    });
    return identity?.accountId ?? null;
  },
};

export async function issueVerificationCodeWithDeps(
  deps: AuthEmailDeps,
  email: string,
  apiCreditsId: string | null = null,
): Promise<void> {
  const code = String(randomInt(100_000, 1_000_000));
  await deps.createCode(email, hashCode(code), new Date(Date.now() + CODE_TTL_MS));
  deps.sendCode(email, code, apiCreditsId).catch((err: unknown) => {
    log.error({ err, email }, "Failed to send verification code");
  });
}

export function issueVerificationCode(email: string, apiCreditsId: string | null = null): Promise<void> {
  return issueVerificationCodeWithDeps(productionDeps, email, apiCreditsId);
}

export const authEmail = createAuthEmailRoutes(productionDeps);
