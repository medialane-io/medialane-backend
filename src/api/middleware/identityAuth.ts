
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

  c.set("walletAddress", id.address);
  return next();
}
