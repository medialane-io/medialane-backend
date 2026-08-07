/**
 * User-identity authentication - layered on top of apiKeyAuth for routes that
 * need to know *which user* is making the request, not just *which tenant*.
 *
 * Accepts a Bearer token in `Authorization: Bearer <token>` and identifies
 * the caller via a SIWS (Sign-In With Starknet) token.
 *
 * The verified identity (wallet address) is stamped onto the Hono context as
 * `walletAddress` for the route handler to read. Apply after apiKeyAuth -
 * never as the sole auth layer.
 */
import type { Context, Next } from "hono";
import { verifyToken as verifySiwsToken } from "../../utils/siwsToken.js";

export async function identityAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const token = authHeader.slice(7);
  const id = verifySiwsToken(token);
  if (!id) return c.json({ error: "Invalid or expired SIWS token" }, 401);
  // Identity is (chain, address) — the token carries both (spec §3.4). Today
  // every caller is Starknet; routes resolve accounts as STARKNET until they
  // consume id.chain, so we stamp the address (behavior unchanged).
  c.set("walletAddress", id.address);
  return next();
}
