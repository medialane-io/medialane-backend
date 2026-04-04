import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Context, Next } from "hono";
import { normalizeAddress } from "../../utils/starknet.js";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
});

/**
 * Verifies user identity from two accepted paths (evaluated in order):
 *
 * Path 1 — Clerk JWT  (Authorization: Bearer <clerk_token>)
 *   Used by medialane.io. Validates JWT, fetches wallet from Clerk user
 *   metadata. Returns 401/403 on any failure. Behavior is identical to the
 *   original implementation — nothing changed for existing callers.
 *
 * Path 2 — Wallet address header  (x-wallet-address: 0x...)
 *   Used by clients that authenticate via tenant API key but have no Clerk
 *   session (e.g. medialane-dapp with browser/Cartridge wallets). Trust is
 *   established by the validated x-api-key that runs before this middleware;
 *   the wallet address is the address the user connected in the dapp.
 *   Only accepted when Authorization: Bearer is absent.
 *
 * Both paths set the same c.get("clerkWallet") context variable so all
 * downstream route handlers work without modification.
 *
 * Usage: call as `return clerkAuth(c, next)` inside a route handler —
 * do NOT register via .use() (c is already AppEnv-typed at call site).
 */
export async function clerkAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  // ── Path 1: Clerk JWT (medialane.io — unchanged) ──────────────────────────
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const payload = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY!,
      });
      const user = await clerk.users.getUser(payload.sub);
      // publicKey is ChipiPay's canonical field — always prefer it.
      // walletAddress is a legacy key written by older code; if both exist publicKey wins.
      const rawWallet = (user.publicMetadata?.publicKey ?? user.publicMetadata?.walletAddress) as string | undefined;
      if (!rawWallet) {
        return c.json({ error: "No wallet associated with this account" }, 403);
      }
      c.set("clerkWallet", normalizeAddress(rawWallet));
      c.set("clerkUserId", payload.sub);
    } catch {
      return c.json({ error: "Invalid or expired session token" }, 401);
    }
    return next();
  }

  // ── Path 2: Wallet address header (medialane-dapp — new) ──────────────────
  // Only reachable when Authorization: Bearer is absent.
  // Requires a valid tenant API key to have already been validated upstream
  // (xApiKeyAuth or global apiKeyAuth) — that is the trust anchor.
  const rawWallet = c.req.header("x-wallet-address");
  if (rawWallet) {
    try {
      c.set("clerkWallet", normalizeAddress(rawWallet));
    } catch {
      return c.json({ error: "Invalid wallet address" }, 400);
    }
    return next();
  }

  // ── No credentials ─────────────────────────────────────────────────────────
  return c.json({ error: "Missing Clerk session token" }, 401);
}

/**
 * Strict variant: only accepts a Clerk JWT in Authorization: Bearer.
 * Rejects the x-wallet-address fallback path entirely.
 *
 * Use on endpoints that grant access to privileged resources (gated content,
 * etc.) where accepting an unverified wallet header would allow impersonation.
 */
export async function clerkJwtOnly(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Clerk session token required" }, 401);
  }
  return clerkAuth(c, next);
}
