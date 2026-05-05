import { createClerkClient, verifyToken as clerkVerifyToken } from "@clerk/backend";
import type { Context, Next } from "hono";
import { normalizeAddress } from "../../utils/starknet.js";
import { verifyToken as verifySiwsToken } from "../../utils/siwsToken.js";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
});

/**
 * Resolves caller identity to a walletAddress from two auth paths:
 *
 * Path 1 — Clerk JWT  (Authorization: Bearer eyJ...)
 *   Used by medialane-io / ChipiPay. Validates JWT via Clerk SDK.
 *   Sets walletAddress + clerkUserId.
 *
 * Path 2 — SIWS token  (Authorization: Bearer siws_...)
 *   Used by medialane-dapp, medialane-portal, AI agents.
 *   Verified locally via HMAC — no DB, no RPC call.
 *   Sets walletAddress only.
 */
export async function identityAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const token = authHeader.slice(7);

  // ── Path 2: SIWS token ─────────────────────────────────────────────────────
  if (token.startsWith("siws_")) {
    const wallet = verifySiwsToken(token);
    if (!wallet) return c.json({ error: "Invalid or expired SIWS token" }, 401);
    c.set("walletAddress", wallet);
    return next();
  }

  // ── Path 1: Clerk JWT ──────────────────────────────────────────────────────
  try {
    const payload = await clerkVerifyToken(token, {
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

/**
 * Strict variant: only accepts a Clerk JWT.
 * Use on endpoints that must not accept SIWS tokens (e.g. gated content, remix confirm).
 */
export async function requireClerkJwt(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ") || authHeader.slice(7).startsWith("siws_")) {
    return c.json({ error: "Clerk session token required" }, 401);
  }
  return identityAuth(c, next);
}
