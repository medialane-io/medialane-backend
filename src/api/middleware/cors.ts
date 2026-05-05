import { cors } from "hono/cors";
import { env } from "../../config/env.js";

// Allowed origins are controlled entirely by CORS_ORIGINS env var.
// Use an explicit allowlist rather than a wildcard subdomain pattern —
// any *.medialane.io pattern would allow a compromised or attacker-registered
// subdomain to make credentialed requests.
const allowedOrigins = new Set(env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean));

function isAllowedOrigin(origin: string): string | undefined {
  return allowedOrigins.has(origin) ? origin : undefined;
}

export const corsMiddleware = cors({
  origin: isAllowedOrigin,
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
  maxAge: 86400,
});
