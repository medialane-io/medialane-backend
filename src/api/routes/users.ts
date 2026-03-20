import { Hono } from "hono";
import prisma from "../../db/client.js";
import { clerkAuth } from "../middleware/clerkAuth.js";
import type { AppEnv } from "../../types/hono.js";

const users = new Hono<AppEnv>();

/**
 * POST /v1/users/me
 * Upsert the authenticated user's wallet address in our DB.
 * Called at onboarding completion. Requires Clerk JWT.
 * The wallet address is read from Clerk publicMetadata (via clerkAuth) —
 * clients do not supply it in the body.
 */
users.post("/me", async (c, next) => clerkAuth(c, next), async (c) => {
  const walletAddress = c.get("clerkWallet") as string;
  const clerkUserId = c.get("clerkUserId") as string;

  await prisma.user.upsert({
    where: { clerkUserId },
    create: { clerkUserId, walletAddress },
    update: { walletAddress },
  });

  return c.json({ walletAddress });
});

/**
 * GET /v1/users/me
 * Return the authenticated user's stored wallet address.
 * Returns 404 if the user has not completed onboarding in the backend yet.
 * Used as a third-tier fallback in the frontend when ChipiPay is unavailable.
 */
users.get("/me", async (c, next) => clerkAuth(c, next), async (c) => {
  const clerkUserId = c.get("clerkUserId") as string;

  const user = await prisma.user.findUnique({ where: { clerkUserId } });
  if (!user) return c.json({ error: "User not found" }, 404);

  return c.json({ walletAddress: user.walletAddress });
});

export default users;
