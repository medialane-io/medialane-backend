import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { createLogger } from "../../utils/logger.js";
import { InMemoryRateLimitStore } from "../middleware/rateLimit.js";
import { getClientIp } from "./admin/_shared.js";
import type { AppEnv } from "../../types/hono.js";

const log = createLogger("routes:airdrop");
const airdrop = new Hono<AppEnv>();

// IP rate limit: 5 signups per minute per IP. The io BFF used to do this
// in-memory and it's the right place anyway (close to the user). Backend
// keeps a second copy to protect against direct hits if the io route is
// bypassed.
const signupRateLimitStore = new InMemoryRateLimitStore();
const SIGNUP_RATE_LIMIT = 5;
const SIGNUP_WINDOW_MS = 60_000;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254).refine((v) => EMAIL_REGEX.test(v), {
    message: "Invalid email",
  }),
  name: z.string().trim().min(2).max(100),
  role: z.enum(["creator", "collector", "developer", "other"]),
});

/**
 * POST /v1/airdrop/register
 *
 * Capture an /airdrop signup. Idempotent on email — re-submitting with the
 * same email updates the name/role rather than creating a duplicate row.
 *
 * Replaces the medialane-io stub at /api/airdrop/register that was logging
 * to stdout and losing every signup. The io route now forwards here.
 */
airdrop.post("/register", zValidator("json", registerSchema), async (c) => {
  const ip = getClientIp(c);
  const { count, resetAt } = await signupRateLimitStore.increment(`airdrop:${ip}`, SIGNUP_WINDOW_MS);
  if (count > SIGNUP_RATE_LIMIT) {
    c.header("Retry-After", String(Math.ceil((resetAt - Date.now()) / 1000)));
    return c.json({ error: "Too many requests" }, 429);
  }

  const { email, name, role } = c.req.valid("json");
  const userAgent = c.req.header("user-agent")?.slice(0, 500) ?? null;

  try {
    const row = await prisma.airdropSignup.upsert({
      where: { email },
      create: { email, name, role, ipAddress: ip === "unknown" ? null : ip, userAgent },
      update: { name, role, ipAddress: ip === "unknown" ? null : ip, userAgent },
      select: { id: true, email: true, role: true, createdAt: true },
    });
    log.info({ id: row.id, role: row.role }, "Airdrop signup captured");
    return c.json({ data: row }, 200);
  } catch (err) {
    log.error({ err }, "Airdrop signup write failed");
    return c.json({ error: "Could not record signup" }, 500);
  }
});

export default airdrop;
