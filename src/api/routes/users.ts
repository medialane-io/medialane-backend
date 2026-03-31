import { Hono } from "hono";
import prisma from "../../db/client.js";
import { clerkAuth } from "../middleware/clerkAuth.js";
import type { AppEnv } from "../../types/hono.js";

const users = new Hono<AppEnv>();

// Mounted before global apiKeyAuth — Clerk JWT only (see @medialane/sdk getMyWallet / upsertMyWallet).

users.get("/me", clerkAuth, async (c) => {
  const clerkUserId = c.get("clerkUserId")!;
  const row = await prisma.userWallet.findUnique({ where: { clerkUserId } });
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ walletAddress: row.walletAddress });
});

users.post("/me", clerkAuth, async (c) => {
  const clerkUserId = c.get("clerkUserId")!;
  const wallet = c.get("clerkWallet")!;
  const row = await prisma.userWallet.upsert({
    where: { clerkUserId },
    create: { clerkUserId, walletAddress: wallet },
    update: { walletAddress: wallet },
  });
  return c.json({ walletAddress: row.walletAddress });
});

export default users;
