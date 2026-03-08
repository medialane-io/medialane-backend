import { cors } from "hono/cors";
import { env } from "../../config/env.js";

const explicitOrigins = env.CORS_ORIGINS.split(",").map((o) => o.trim());

// Allow any origin that ends with medialane.io (handles www + subdomains)
// plus any explicitly listed origins (localhost, custom domains, etc.)
function isAllowedOrigin(origin: string): string | undefined {
  if (explicitOrigins.includes(origin)) return origin;
  if (origin.endsWith(".medialane.io") || origin === "https://medialane.io") return origin;
  return undefined;
}

export const corsMiddleware = cors({
  origin: isAllowedOrigin,
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
  maxAge: 86400,
});
