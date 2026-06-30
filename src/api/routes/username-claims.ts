import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import prisma from "../../db/client.js";
import { normalizeAddress } from "../../utils/starknet.js";
import { identityAuth } from "../middleware/identityAuth.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { apiKeyRateLimit } from "../middleware/rateLimit.js";
import { meter } from "../middleware/meter.js";
import { resolveAccountIdFromWallet } from "../../utils/account.js";
import type { AppEnv } from "../../types/hono.js";

const usernameClaims = new Hono<AppEnv>();

// Username rules:
// - 3–20 chars
// - lowercase letters, numbers, underscores, hyphens
// - cannot start or end with _ or -
const USERNAME_REGEX = /^[a-z0-9][a-z0-9_-]{1,18}[a-z0-9]$|^[a-z0-9]{3}$/;

const RESERVED = new Set([
  "admin", "api", "www", "medialane", "creator", "creators", "account",
  "portfolio", "support", "docs", "about", "discover", "marketplace",
  "collections", "activities", "launchpad", "create", "search",
  "settings", "help", "legal", "terms", "privacy", "contact",
  "team", "dao", "blog", "news", "status", "security",
]);

function validateUsername(username: string): string | null {
  if (!USERNAME_REGEX.test(username)) {
    return "Username must be 3–20 characters and contain only lowercase letters, numbers, underscores, and hyphens. Cannot start or end with _ or -.";
  }
  if (RESERVED.has(username)) {
    return "That username is reserved.";
  }
  return null;
}

// ─── GET /v1/username-claims/check/:username ─────────────────────────────────
// Public availability check — no auth required.

usernameClaims.get("/check/:username", async (c) => {
  const slug = c.req.param("username").toLowerCase().trim();

  const validationError = validateUsername(slug);
  if (validationError) return c.json({ available: false, reason: validationError });

  if (RESERVED.has(slug)) return c.json({ available: false, reason: "That username is reserved." });

  const [takenProfile, pendingClaim] = await Promise.all([
    prisma.accountProfile.findUnique({ where: { username: slug }, select: { accountId: true } }),
    prisma.usernameClaim.findFirst({ where: { username: slug, status: { in: ["PENDING", "APPROVED"] } } }),
  ]);

  if (takenProfile || pendingClaim) {
    return c.json({ available: false, reason: "That username is already taken." });
  }

  return c.json({ available: true });
});

// ─── POST /v1/username-claims ─────────────────────────────────────────────────
// Submit a username claim for DAO review.
// Auth: standard API key + Clerk JWT. This router is mounted before the global
// apiKeyAuth/apiKeyRateLimit/meter chain in server.ts, so they're wired explicitly
// here — otherwise tenant auth, quota, and metering silently never run on this
// route despite this comment's original intent (2026-06-30 audit finding).

usernameClaims.post(
  "/",
  apiKeyAuth,
  apiKeyRateLimit(),
  meter(),
  identityAuth,
  zValidator("json", z.object({ username: z.string(), notifyEmail: z.string().email().optional() })),
  async (c) => {
    const jwtWallet = c.get("walletAddress") as string;
    const { username, notifyEmail } = c.req.valid("json");
    const slug = username.toLowerCase().trim();

    const validationError = validateUsername(slug);
    if (validationError) return c.json({ error: validationError }, 400);

    // Check if the user already has an approved username
    const callerAccountId = await resolveAccountIdFromWallet("STARKNET", jwtWallet);
    if (callerAccountId) {
      const profile = await prisma.accountProfile.findUnique({
        where: { accountId: callerAccountId },
        select: { username: true },
      });
      if (profile?.username) {
        return c.json({ error: "You already have an approved username." }, 409);
      }
    }

    // Check if there's already a PENDING claim from this wallet
    const pendingFromWallet = await prisma.usernameClaim.findFirst({
      where: { walletAddress: jwtWallet, status: "PENDING" },
    });
    if (pendingFromWallet) {
      return c.json({ error: "You already have a pending username claim. Wait for it to be reviewed before submitting another." }, 409);
    }

    // Check if username is taken (approved profile or pending/approved claim)
    const takenProfile = await prisma.accountProfile.findUnique({
      where: { username: slug },
      select: { accountId: true },
    });
    if (takenProfile) return c.json({ error: "That username is already taken." }, 409);

    const pendingClaim = await prisma.usernameClaim.findFirst({
      where: { username: slug, status: { in: ["PENDING", "APPROVED"] } },
    });
    if (pendingClaim) return c.json({ error: "That username is already claimed or pending review." }, 409);

    const claim = await prisma.usernameClaim.create({
      data: { username: slug, walletAddress: jwtWallet, status: "PENDING", notifyEmail: notifyEmail ?? null },
    });

    return c.json({ claim }, 201);
  }
);

// ─── GET /v1/username-claims/me ──────────────────────────────────────────────
// Returns the current user's most recent claim and their approved username if any.

usernameClaims.get(
  "/me",
  apiKeyAuth,
  apiKeyRateLimit(),
  meter(),
  identityAuth,
  async (c) => {
    const jwtWallet = c.get("walletAddress") as string;

    const accountId = await resolveAccountIdFromWallet("STARKNET", jwtWallet);
    const [profile, latestClaim] = await Promise.all([
      accountId
        ? prisma.accountProfile.findUnique({
            where: { accountId },
            select: { username: true },
          })
        : Promise.resolve(null),
      prisma.usernameClaim.findFirst({
        where: { walletAddress: jwtWallet },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    return c.json({
      username: profile?.username ?? null,
      claim: latestClaim,
    });
  }
);

export default usernameClaims;
