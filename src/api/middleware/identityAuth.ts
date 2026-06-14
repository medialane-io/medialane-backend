/**
 * User-identity authentication - layered on top of apiKeyAuth for routes that
 * need to know *which user* is making the request, not just *which tenant*.
 *
 * Accepts a Bearer token in `Authorization: Bearer <token>` and identifies
 * the caller via one of two providers:
 *   - Clerk JWT (for medialane-io users authenticated via Clerk)
 *   - SIWS (Sign-In With Starknet) token (for medialane-dapp users)
 *
 * The verified identity (wallet address + provider) is stamped onto the Hono
 * context as `identity` for the route handler to read. Apply after
 * apiKeyAuth - never as the sole auth layer.
 */
import type { Context, Next } from "hono";
import { normalizeAddress } from "../../utils/starknet.js";
import { verifyToken as verifySiwsToken } from "../../utils/siwsToken.js";
import { env } from "../../config/env.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("middleware:identityAuth");

// Lazily initialised — only created on the first Clerk JWT request.
// SIWS callers (the majority) never pay the Clerk SDK initialisation cost.
let _clerk: Awaited<ReturnType<typeof import("@clerk/backend").createClerkClient>> | null = null;
function getClerk() {
  if (!_clerk) {
    if (!env.CLERK_SECRET_KEY) {
      throw new Error("CLERK_SECRET_KEY is not configured — Clerk JWT auth unavailable");
    }
    const { createClerkClient } = require("@clerk/backend");
    _clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  }
  return _clerk!;
}

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
    const { verifyToken: clerkVerifyToken } = require("@clerk/backend");
    const payload = await clerkVerifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });
    const user = await getClerk().users.getUser(payload.sub);
    const rawWallet = (user.publicMetadata?.publicKey ?? user.publicMetadata?.walletAddress) as string | undefined;
    if (!rawWallet) {
      return c.json({ error: "No wallet associated with this account" }, 403);
    }
    c.set("walletAddress", normalizeAddress("STARKNET", rawWallet));
    c.set("clerkUserId", payload.sub);
  } catch (err) {
    // Log the underlying error so the next "Invalid or expired session token"
    // incident can be diagnosed from Railway logs without code spelunking. The
    // 401 surfaces as a single user-facing message; the *reason* (JWT expired,
    // CLERK_SECRET_KEY misconfigured, Clerk API outage, JWKS network failure,
    // user.publicMetadata.publicKey unset) lives here.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), path: c.req.path },
      "Clerk JWT verification failed"
    );
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
