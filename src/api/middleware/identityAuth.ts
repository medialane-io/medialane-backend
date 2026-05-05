import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Context, Next } from "hono";
import { normalizeAddress } from "../../utils/starknet.js";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
});

/**
 * Resolves caller identity to a walletAddress from a verified Clerk JWT.
 *
 * Path 1 — Clerk JWT  (Authorization: Bearer <token>)
 *   Validates JWT, fetches wallet from Clerk metadata.
 *   Sets walletAddress + clerkUserId.
 *
 * Path 2 (future) — SIWS signature
 *   Reserved for stateless Starknet signature verification.
 */
export async function identityAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
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

  // Path 2: SIWS signature (future)
  // Reserved for stateless Starknet signature verification.

  return c.json({ error: "Authentication required" }, 401);
}

/**
 * Strict variant: only accepts Clerk JWT in Authorization: Bearer.
 * Alias for identityAuth — kept for call-site clarity and future divergence.
 */
export async function requireClerkJwt(c: Context, next: Next) {
  return identityAuth(c, next);
}
