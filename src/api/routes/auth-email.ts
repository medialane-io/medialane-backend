import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createHmac, timingSafeEqual, randomInt } from "crypto";
import prisma from "../../db/client.js";
import { env } from "../../config/env.js";
import { sendVerificationCode } from "../../utils/mailer.js";
import { issueEmailVerifiedToken } from "../../utils/emailVerificationToken.js";
import { issueAccountSessionToken } from "../../utils/accountSessionToken.js";
import { DEFAULT_GRACE_DAYS } from "../../utils/emailVerification.js";
import { releaseAbandonedEmail } from "../../utils/emailClaim.js";
import { createLogger } from "../../utils/logger.js";
import { IDENTITY_SCHEME, normalizeIdentityValue } from "../../utils/identity.js";
import type { AppEnv } from "../../types/hono.js";

import { ensureAccountForIdentity } from "../../utils/account.js";

const log = createLogger("routes:auth-email");

const CODE_TTL_MS = 10 * 60 * 1000;
const UNVERIFIED_SESSION_TTL_SECONDS = DEFAULT_GRACE_DAYS * 24 * 60 * 60;
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
  sendCode: (to: string, code: string, tenant: string | null) => Promise<void>;
  checkEmailExists: (email: string, tenant: string) => Promise<boolean>;
  createAccountWithEmail: (email: string, tenant: string) => Promise<{ accountId: string; alreadyExisted: boolean }>;
  findAccountIdByEmail: (email: string, tenant: string) => Promise<string | null>;
  releaseAbandonedEmail: (email: string, tenant: string) => Promise<boolean>;
  findWaitingWallets: (email: string) => Promise<string[]>;
  createVerifiedAccount: (email: string, tenant: string) => Promise<string>;
  markEmailVerified: (email: string, tenant: string) => Promise<void>;
}

const CODE_HASH_DOMAIN = "otp-code-v1";

function hashCode(code: string): string {
  return createHmac("sha256", env.SIWS_SECRET).update(`${CODE_HASH_DOMAIN}.${code}`).digest("hex");
}

const requestCodeSchema = z.object({ email: z.string().email() });
const verifyCodeSchema = z.object({ email: z.string().email(), code: z.string().length(6) });
const existsQuerySchema = z.object({ email: z.string().email() });
const registerAccountSchema = z.object({ email: z.string().email() });

function tenantOf(c: Context<AppEnv>): string | null {
  return c.get("apiKey")?.tenantId ?? null;
}

const NO_TENANT = {
  error: "unknown_app",
  message: "This API key is not attached to an app, so an account cannot be resolved for it.",
} as const;

export function createAuthEmailRoutes(deps: AuthEmailDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/request-code", zValidator("json", requestCodeSchema), async (c) => {
    const { email } = c.req.valid("json");
    await issueVerificationCodeWithDeps(deps, email, tenantOf(c));
    return c.json({ ok: true });
  });

  app.post("/verify-code", zValidator("json", verifyCodeSchema), async (c) => {
    const tenant = tenantOf(c);
    if (!tenant) return c.json(NO_TENANT, 400);

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
    const token = issueEmailVerifiedToken(email);

    await deps.releaseAbandonedEmail(email, tenant);

    let accountId = await deps.findAccountIdByEmail(email, tenant);
    if (accountId) await deps.markEmailVerified(email, tenant);
    else accountId = await deps.createVerifiedAccount(email, tenant);
    const waitingWallets = await deps.findWaitingWallets(normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email));
    return c.json({ token, accountToken: issueAccountSessionToken(accountId), waitingWallets });
  });

  app.get("/exists", zValidator("query", existsQuerySchema), async (c) => {
    const tenant = tenantOf(c);
    if (!tenant) return c.json(NO_TENANT, 400);

    const { email } = c.req.valid("query");
    const exists = await deps.checkEmailExists(email, tenant);
    const walletWaiting = (await deps.findWaitingWallets(normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email))).length > 0;
    return c.json({ exists, walletWaiting });
  });

  app.post("/register-account", zValidator("json", registerAccountSchema), async (c) => {
    const { email } = c.req.valid("json");
    const tenant = tenantOf(c);
    if (!tenant) return c.json(NO_TENANT, 400);

    const { accountId, alreadyExisted } = await deps.createAccountWithEmail(email, tenant);
    if (alreadyExisted) {
      return c.json({ error: "ACCOUNT_EXISTS", message: "Verify this address with a code to sign in." }, 409);
    }
    return c.json({ accountToken: issueAccountSessionToken(accountId, UNVERIFIED_SESSION_TTL_SECONDS) });
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
  checkEmailExists: async (email, tenant) => {
    const identity = await prisma.identity.findUnique({
      where: { scheme_value_tenantId: { scheme: IDENTITY_SCHEME.EMAIL, value: email, tenantId: tenant } },
      select: { id: true },
    });
    return identity !== null;
  },
  createAccountWithEmail: async (email, tenant) => {
    const { accountId, created } = await ensureAccountForIdentity(IDENTITY_SCHEME.EMAIL, email, tenant);
    return { accountId, alreadyExisted: !created };
  },
  releaseAbandonedEmail,
  findWaitingWallets: async (email) =>
    (
      await prisma.businessProvisioning.findMany({
        where: {
          recipientScheme: IDENTITY_SCHEME.EMAIL,
          recipientValue: email,
          status: "DEPLOYED",
          interimOwnerPubkey: { not: null },
          derivationSalt: { not: null },
        },
        select: { walletAddress: true },
      })
    ).map((row) => row.walletAddress),
  createVerifiedAccount: async (email, tenant) => {
    const { accountId } = await ensureAccountForIdentity(IDENTITY_SCHEME.EMAIL, email, tenant);
    await prisma.identity.updateMany({
      where: { scheme: IDENTITY_SCHEME.EMAIL, value: normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email), tenantId: tenant },
      data: { verifiedAt: new Date() },
    });
    return accountId;
  },
  markEmailVerified: async (email, tenant) => {
    await prisma.identity.updateMany({
      where: {
        scheme: IDENTITY_SCHEME.EMAIL,
        value: { in: [email, normalizeIdentityValue(IDENTITY_SCHEME.EMAIL, email)] },
        tenantId: tenant,
        verifiedAt: null,
      },
      data: { verifiedAt: new Date() },
    });
  },
  findAccountIdByEmail: async (email, tenant) => {
    const identity = await prisma.identity.findUnique({
      where: { scheme_value_tenantId: { scheme: IDENTITY_SCHEME.EMAIL, value: email, tenantId: tenant } },
      select: { accountId: true },
    });
    return identity?.accountId ?? null;
  },
};

export async function issueVerificationCodeWithDeps(
  deps: AuthEmailDeps,
  email: string,
  tenant: string | null = null,
): Promise<void> {
  const code = String(randomInt(100_000, 1_000_000));
  await deps.createCode(email, hashCode(code), new Date(Date.now() + CODE_TTL_MS));
  deps.sendCode(email, code, tenant).catch((err: unknown) => {
    log.error({ err, email }, "Failed to send verification code");
  });
}

export function issueVerificationCode(email: string, tenant: string | null = null): Promise<void> {
  return issueVerificationCodeWithDeps(productionDeps, email, tenant);
}

export const authEmail = createAuthEmailRoutes(productionDeps);
