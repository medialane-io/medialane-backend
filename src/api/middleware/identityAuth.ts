import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Context, Next } from "hono";
import { normalizeAddress } from "../../utils/starknet.js";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
});

/**
 * Resolves caller identity to a walletAddress from two auth paths:
 *
 * Path 1 — Clerk JWT  (Authorization: Bearer <token>)
 *   Used by medialane.io. Validates JWT, fetches wallet from Clerk metadata.
 *   Sets walletAddress + clerkUserId.
 *
 * Path 2 — Wallet-address header  (x-wallet-address: 0x...)
 *   Used by medialane-dapp. Trust established by upstream API key validation.
 *   Sets walletAddress only.
 *
 * Path 3 (future) — SIWS signature
 *   Slot reserved for stateless Starknet signature verification.
 */
export async function identityAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  // ── Path 1: Clerk JWT ───────────────────────────────────────────────────────
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

  // ── Path 2: Wallet-address header ──────────────────────────────────────────
  // Only reachable when Authorization: Bearer is absent.
  // Requires a valid tenant API key to have already been validated upstream.
  const rawWallet = c.req.header("x-wallet-address");
  if (rawWallet) {
    try {
      c.set("walletAddress", normalizeAddress(rawWallet));
    } catch {
      return c.json({ error: "Invalid wallet address" }, 400);
    }
    return next();
  }

  // ── Path 3: SIWS signature (future) ────────────────────────────────────────
  // Reserved for stateless Starknet signature verification.
  // When implemented: verify typed-data signature against x-wallet-address,
  // check timestamp freshness, set walletAddress.

  return c.json({ error: "Authentication required" }, 401);
}

/**
 * Strict variant: only accepts Clerk JWT in Authorization: Bearer.
 * Use on endpoints where an unverified wallet-header would allow impersonation.
 */
export async function requireClerkJwt(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Clerk session token required" }, 401);
  }
  return identityAuth(c, next);
}
