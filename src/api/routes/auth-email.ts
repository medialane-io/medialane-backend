import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createHmac, timingSafeEqual, randomInt } from "crypto";
import prisma from "../../db/client.js";
import { env } from "../../config/env.js";
import { sendVerificationCode } from "../../utils/mailer.js";
import { issueAccountSessionToken } from "../../utils/accountSessionToken.js";
import { releaseAbandonedEmail } from "../../utils/emailClaim.js";
import { createLogger } from "../../utils/logger.js";
import { IDENTITY_SCHEME, normalizeIdentityValue } from "../../utils/identity.js";
import type { AppEnv } from "../../types/hono.js";
import { callerClientId } from "../../utils/caller.js";

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
  incrementAttempts: (id: string) => Promise<void>;
  consumeCode: (id: string) => Promise<void>;
  sendCode: (to: string, code: string, clientId: string | null) => Promise<void>;
  checkEmailExists: (email: string, clientId: string) => Promise<boolean>;
  createAccountWithEmail: (email: string, clientId: string) => Promise<{ accountId: string; alreadyExisted: boolean }>;
  findAccountIdByEmail: (email: string, clientId: string) => Promise<string | null>;
  releaseAbandonedEmail: (email: string, clientId: string) => Promise<boolean>;
  createVerifiedAccount: (email: string, clientId: string) => Promise<string>;
  markEmailVerified: (email: string, clientId: string) => Promise<void>;
  activateAccount: (accountId: string) => Promise<void>;
}

const CODE_HASH_DOMAIN = "otp-code-v1";

function hashCode(code: string): string {
  return createHmac("sha256", env.SIWS_SECRET).update(`${CODE_HASH_DOMAIN}.${code}`).digest("hex");
}

const requestCodeSchema = z.object({ email: z.string().email() });
const verifyCodeSchema = z.object({ email: z.string().email(), code: z.string().length(6) });
const existsQuerySchema = z.object({ email: z.string().email() });
const registerAccountSchema = z.object({ email: z.string().email() });



const NO_CLIENT = {
  error: "unknown_client",
  message: "This API key has no client, so an account cannot be resolved for it.",
} as const;

export function createAuthEmailRoutes(deps: AuthEmailDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/request-code", zValidator("json", requestCodeSchema), async (c) => {
    const { email } = c.req.valid("json");
    await issueVerificationCodeWithDeps(deps, email, callerClientId(c));
    return c.json({ ok: true });
  });

  app.post("/verify-code", zValidator("json", verifyCodeSchema), async (c) => {
    const clientId = callerClientId(c);
    if (!clientId) return c.json(NO_CLIENT, 400);

    const { email, code } = c.req.valid("json");
    const stored = await deps.findLatestCode(email);

    if (!stored || stored.consumedAt || stored.expiresAt < new Date()) {
      return c.json({ error: "Invalid or expired code" }, 400);
    }
    if (stored.attempts >= MAX_ATTEMPTS) {
      return c.json({ error: "Too many attempts — request a new code" }, 429);
    }

    const provided = hashCode(code);
    const expected = stored.codeHash;
    const matches =
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));

    if (!matches) {
      await deps.incrementAttempts(stored.id);
      return c.json({ error: "Incorrect code" }, 400);
    }

    await deps.consumeCode(stored.id);

    await deps.releaseAbandonedEmail(email, clientId);

    let accountId = await deps.findAccountIdByEmail(email, clientId);
    if (accountId) {
      await deps.markEmailVerified(email, clientId);
      await deps.activateAccount(accountId);
    } else {
      accountId = await deps.createVerifiedAccount(email, clientId);
    }
    return c.json({ accountToken: issueAccountSessionToken(accountId) });
  });

  app.get("/exists", zValidator("query", existsQuerySchema), async (c) => {
    const clientId = callerClientId(c);
    if (!clientId) return c.json(NO_CLIENT, 400);

    const { email } = c.req.valid("query");
    const exists = await deps.checkEmailExists(email, clientId);
    return c.json({ exists });
  });

  app.post("/register-account", zValidator("json", registerAccountSchema), async (c) => {
    const { email } = c.req.valid("json");
    const clientId = callerClientId(c);
    if (!clientId) return c.json(NO_CLIENT, 400);

    const { accountId, alreadyExisted } = await deps.createAccountWithEmail(email, clientId);
    if (alreadyExisted) {
      return c.json({ error: "ACCOUNT_EXISTS", message: "Verify this address with a code to sign in." }, 409);
    }
    return c.json({ accountToken: issueAccountSessionToken(accountId) });
  });

  return app;
}

const productionDeps: AuthEmailDeps = {
  findLatestCode: (email) =>
    prisma.emailVerificationCode.findFirst({ where: { email }, orderBy: { createdAt: "desc" } }),
  createCode: async (email, codeHash, expiresAt) => {
    await prisma.emailVerificationCode.create({ data: { email, codeHash, expiresAt } });
  },
  incrementAttempts: async (id) => {
    await prisma.emailVerificationCode.update({ where: { id }, data: { attempts: { increment: 1 } } });
  },
  consumeCode: async (id) => {
    await prisma.emailVerificationCode.update({ where: { id }, data: { consumedAt: new Date() } });
  },
  sendCode: sendVerificationCode,
  checkEmailExists: async (email, clientId) => {
    const identity = await prisma.identity.findUnique({
      where: { clientId_scheme_value: { clientId: clientId, scheme: IDENTITY_SCHEME.EMAIL, value: email } },
      select: { id: true },
    });
    return identity !== null;
  },
  createAccountWithEmail: async (email, clientId) => {
    const { accountId, created } = await ensureAccountForIdentity(IDENTITY_SCHEME.EMAIL, email, clientId);
    if (created) await prisma.account.update({ where: { id: accountId }, data: { status: "PENDING" } });
    return { accountId, alreadyExisted: !created };
  },
  activateAccount: async (accountId) => {
    await prisma.account.updateMany({ where: { id: accountId, status: "PENDING" }, data: { status: "ACTIVE" } });
  },
  releaseAbandonedEmail,
  createVerifiedAccount: async (email, clientId) => {
    const { accountId } = await ensureAccountForIdentity(IDENTITY_SCHEME.EMAIL, email, clientId);
    await prisma.identity.updateMany({
      where: { scheme: IDENTITY_SCHEME.EMAIL, value: normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email), clientId: clientId },
      data: { verifiedAt: new Date() },
    });
    return accountId;
  },
  markEmailVerified: async (email, clientId) => {
    await prisma.identity.updateMany({
      where: {
        scheme: IDENTITY_SCHEME.EMAIL,
        value: { in: [email, normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email)] },
        clientId: clientId,
        verifiedAt: null,
      },
      data: { verifiedAt: new Date() },
    });
  },
  findAccountIdByEmail: async (email, clientId) => {
    const identity = await prisma.identity.findUnique({
      where: { clientId_scheme_value: { clientId: clientId, scheme: IDENTITY_SCHEME.EMAIL, value: email } },
      select: { accountId: true },
    });
    return identity?.accountId ?? null;
  },
};

export async function issueVerificationCodeWithDeps(
  deps: AuthEmailDeps,
  email: string,
  clientId: string | null = null,
): Promise<void> {
  const code = String(randomInt(100_000, 1_000_000));
  await deps.createCode(email, hashCode(code), new Date(Date.now() + CODE_TTL_MS));
  deps.sendCode(email, code, clientId).catch((err: unknown) => {
    log.error({ err, email }, "Failed to send verification code");
  });
}

export function issueVerificationCode(email: string, clientId: string | null = null): Promise<void> {
  return issueVerificationCodeWithDeps(productionDeps, email, clientId);
}

export const authEmail = createAuthEmailRoutes(productionDeps);
