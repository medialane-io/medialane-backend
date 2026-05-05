import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Context, Next } from "hono";
import { normalizeAddress } from "../../utils/starknet.js";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
});

/**
 * Verifies caller identity from a Clerk JWT (Authorization: Bearer <token>).
 * Sets walletAddress + clerkUserId on the context.
 *
 * Future: Path 2 (SIWS) reserved for stateless Starknet signature verification.
 */
export async function requireClerkJwt(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });
    const user = await clerk.users.getUser(payload.sub);
    const rawWallet = (user.publicMetadata?.publicKey ?? user.publicMetadata?.walletAddress) as string | undefined;
    if (!rawWallet) {
      return c.json({ error: "No wallet associated with this account" }, 403);
    }
    c.set("walletAddress", normalizeAddress(rawWallet));
    c.set("clerkUserId", payload.sub);
  } catch {
    return c.json({ error: "Invalid or expired session token" }, 401);
  }

  return next();
}
