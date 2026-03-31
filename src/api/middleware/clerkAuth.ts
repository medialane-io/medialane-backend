import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Context, Next } from "hono";
import { normalizeAddress } from "../../utils/starknet.js";
import { createLogger } from "../../utils/logger.js";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
});
const log = createLogger("middleware:clerkAuth");

/**
 * Verifies the Clerk session JWT from Authorization: Bearer <token>.
 * Reads publicMetadata.walletAddress from the verified user record.
 * Attaches normalised wallet to c.get("clerkWallet").
 * Returns 401 if token missing/invalid, 403 if no wallet in metadata.
 *
 * Usage: call as `return clerkAuth(c, next)` inside a route handler —
 * do NOT register via .use() (c is already AppEnv-typed at call site).
 */
export async function clerkAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Clerk session token" }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });
    c.set("clerkUserId", payload.sub);
    const user = await clerk.users.getUser(payload.sub);
    // Backward compatibility: older onboarding stored `publicKey`; newer stores `walletAddress`.
    const rawWallet =
      (user.publicMetadata?.walletAddress as string | undefined) ??
      (user.publicMetadata?.publicKey as string | undefined);
    if (!rawWallet) {
      return c.json({ error: "No wallet associated with this account" }, 403);
    }
    c.set("clerkWallet", normalizeAddress(rawWallet));
  } catch (err) {
    log.warn(
      { err },
      "Clerk token verification failed (check CLERK_SECRET_KEY, token template, and token freshness)"
    );
    return c.json({ error: "Invalid or expired session token" }, 401);
  }
  await next();
}
