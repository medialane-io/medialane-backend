import { Hono } from "hono";
import prisma from "../../db/client.js";
import { identityAuth } from "../middleware/identityAuth.js";
import type { AppEnv } from "../../types/hono.js";

const users = new Hono<AppEnv>();

/**
 * POST /v1/users/me
 * Upsert the authenticated user's wallet address in our DB.
 * Called at onboarding completion. Works with any identityAuth path.
 */
users.post("/me", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;

  await prisma.user.upsert({
    where: { walletAddress },
    create: { walletAddress },
    update: {},
  });

  return c.json({ walletAddress });
});

/**
 * GET /v1/users/me
 * Return the authenticated user's stored wallet address.
 * Returns 404 if the user has not called POST /v1/users/me yet.
 */
users.get("/me", async (c, next) => identityAuth(c, next), async (c) => {
  const walletAddress = c.get("walletAddress") as string;

  const user = await prisma.user.findUnique({ where: { walletAddress } });
  if (!user) return c.json({ error: "User not found" }, 404);

  return c.json({ walletAddress: user.walletAddress });
});

export default users;
