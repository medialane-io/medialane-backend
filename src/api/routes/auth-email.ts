import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createHmac, timingSafeEqual, randomInt } from "crypto";
import prisma from "../../db/client.js";
import { env } from "../../config/env.js";
import { sendVerificationCode } from "../../utils/mailer.js";
import { issueEmailVerifiedToken } from "../../utils/emailVerificationToken.js";
import { generateAccountPublicId } from "../../utils/account.js";
import { issueAccountSessionToken } from "../../utils/accountSessionToken.js";
import { InMemoryRateLimitStore, type RateLimitStore } from "../middleware/rateLimit.js";
import { createRedisStore } from "../middleware/redisRateLimit.js";
import { createLogger } from "../../utils/logger.js";
import { IDENTITY_SCHEME } from "../../utils/identity.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:auth-email");

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const EMAIL_REQUEST_LIMIT = 3;
const IP_REQUEST_LIMIT = 10;
const RATE_WINDOW_MS = 15 * 60 * 1000;

const rateLimitStore: RateLimitStore = env.REDIS_URL
  ? createRedisStore(env.REDIS_URL)
  : new InMemoryRateLimitStore();

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
  sendCode: (to: string, code: string) => Promise<void>;
  checkRateLimit: (email: string, ip: string) => Promise<boolean>;
  checkEmailExists: (email: string) => Promise<boolean>;
  createAccountWithEmail: (email: string) => Promise<{ accountId: string; alreadyExisted: boolean }>;
  checkAccountCreateRateLimit: (ip: string) => Promise<boolean>;
  findAccountIdByEmail: (email: string) => Promise<string | null>;
}

function hashCode(code: string): string {
  return createHmac("sha256", env.SIWS_SECRET).update(code).digest("hex");
}

const requestCodeSchema = z.object({ email: z.string().email() });
const verifyCodeSchema = z.object({ email: z.string().email(), code: z.string().length(6) });
const existsQuerySchema = z.object({ email: z.string().email() });
const registerAccountSchema = z.object({ email: z.string().email() });

export function createAuthEmailRoutes(deps: AuthEmailDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/request-code", zValidator("json", requestCodeSchema), async (c) => {
    const { email } = c.req.valid("json");
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    const allowed = await deps.checkRateLimit(email, ip);
    if (!allowed) return c.json({ error: "Too many requests" }, 429);

    const code = String(randomInt(100_000, 1_000_000));
    await deps.createCode(email, hashCode(code), new Date(Date.now() + CODE_TTL_MS));

    deps.sendCode(email, code).catch((err: unknown) => {
      log.error({ err, email }, "Failed to send verification code");
    });

    return c.json({ ok: true });
  });

  app.post("/verify-code", zValidator("json", verifyCodeSchema), async (c) => {
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
    const accountId = await deps.findAccountIdByEmail(email);
    return c.json({
      token,
      ...(accountId ? { accountToken: issueAccountSessionToken(accountId) } : {}),
    });
  });

  app.get("/exists", zValidator("query", existsQuerySchema), async (c) => {
    const { email } = c.req.valid("query");
    const exists = await deps.checkEmailExists(email);
    return c.json({ exists });
  });

  app.post("/register-account", zValidator("json", registerAccountSchema), async (c) => {
    const { email } = c.req.valid("json");
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    const allowed = await deps.checkAccountCreateRateLimit(ip);
    if (!allowed) return c.json({ error: "Too many requests" }, 429);

    const { accountId } = await deps.createAccountWithEmail(email);
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
  checkRateLimit: async (email, ip) => {
    const emailResult = await rateLimitStore.increment(`ratelimit:email-code:${email}`, RATE_WINDOW_MS);
    if (emailResult.count > EMAIL_REQUEST_LIMIT) {
      log.warn({ email }, "email-code rate limit hit (per-email)");
      return false;
    }
    const ipResult = await rateLimitStore.increment(`ratelimit:email-code-ip:${ip}`, RATE_WINDOW_MS);
    if (ipResult.count > IP_REQUEST_LIMIT) {
      log.warn({ ip }, "email-code rate limit hit (per-IP)");
      return false;
    }
    return true;
  },
  checkEmailExists: async (email) => {
    const identity = await prisma.identity.findUnique({
      where: { scheme_value: { scheme: IDENTITY_SCHEME.EMAIL, value: email } },
      select: { id: true },
    });
    return identity !== null;
  },
  createAccountWithEmail: async (email) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const account = await prisma.account.create({
          data: { publicId: generateAccountPublicId(), type: "PERSON", roles: [] },
          select: { id: true },
        });
        await prisma.identity.create({
          data: {
            accountId: account.id,
            scheme: IDENTITY_SCHEME.EMAIL,
            value: email,
            email,
            appSource: "MEDIALANE_IO",
            verifiedAt: null,
          },
        });
        return { accountId: account.id, alreadyExisted: false };
      } catch (err) {

        const isUniqueViolation =
          typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002";
        if (!isUniqueViolation) throw err;
        const existing = await prisma.identity.findUnique({
          where: { scheme_value: { scheme: IDENTITY_SCHEME.EMAIL, value: email } },
          select: { accountId: true },
        });
        if (existing) return { accountId: existing.accountId, alreadyExisted: true };

      }
    }
    throw new Error("Failed to create account after 3 attempts");
  },
  checkAccountCreateRateLimit: async (ip) => {
    const result = await rateLimitStore.increment(`ratelimit:account-create-ip:${ip}`, 60 * 60 * 1000);
    if (result.count > 10) {
      log.warn({ ip }, "account-creation rate limit hit (per-IP)");
      return false;
    }
    return true;
  },
  findAccountIdByEmail: async (email) => {
    const identity = await prisma.identity.findUnique({
      where: { scheme_value: { scheme: IDENTITY_SCHEME.EMAIL, value: email } },
      select: { accountId: true },
    });
    return identity?.accountId ?? null;
  },
};

// Shared with users.ts — sends a fresh code the moment an email is added to
// an account, not just when a user later happens to visit Settings and ask
// for one. Same code path (storage, hashing, delivery) as /request-code.
export async function issueVerificationCode(email: string): Promise<void> {
  const code = String(randomInt(100_000, 1_000_000));
  await productionDeps.createCode(email, hashCode(code), new Date(Date.now() + CODE_TTL_MS));
  productionDeps.sendCode(email, code).catch((err: unknown) => {
    log.error({ err, email }, "Failed to send verification code");
  });
}

export const authEmail = createAuthEmailRoutes(productionDeps);
