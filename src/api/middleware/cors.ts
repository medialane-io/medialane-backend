import { cors } from "hono/cors";
import { env } from "../../config/env.js";

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
