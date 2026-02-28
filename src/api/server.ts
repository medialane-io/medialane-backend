import { Hono } from "hono";
import type { AppEnv } from "../types/hono.js";
import { corsMiddleware } from "./middleware/cors.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { apiKeyAuth } from "./middleware/apiKeyAuth.js";
import { apiKeyRateLimit } from "./middleware/rateLimit.js";
import { usageLogger } from "./middleware/usageLogger.js";
import health from "./routes/health.js";
import orders from "./routes/orders.js";
import tokens from "./routes/tokens.js";
import collections from "./routes/collections.js";
import activities from "./routes/activities.js";
import intents from "./routes/intents.js";
import metadata from "./routes/metadata.js";
import search from "./routes/search.js";
import portal from "./routes/portal.js";
import admin from "./routes/admin.js";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Global middleware
  app.use("*", corsMiddleware);
  app.use("*", loggerMiddleware);

  // Health stays unauthenticated (monitoring, uptime checks)
  app.route("/health", health);

  // Admin routes — internal auth (API_SECRET_KEY) handled inside admin.ts
  app.route("/admin", admin);

  // All /v1/* routes require a tenant API key
  app.use("/v1/*", apiKeyAuth);
  app.use("/v1/*", apiKeyRateLimit());
  app.use("/v1/*", usageLogger);

  // Tenant self-service portal
  app.route("/v1/portal", portal);

  // Existing data routes
  app.route("/v1/orders", orders);
  app.route("/v1/tokens", tokens);
  app.route("/v1/collections", collections);
  app.route("/v1/activities", activities);
  app.route("/v1/intents", intents);
  app.route("/v1/metadata", metadata);
  app.route("/v1/search", search);

  // 404 fallback
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  // Global error handler
  app.onError((err, c) => {
    console.error("[app error]", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
