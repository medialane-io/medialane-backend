import { Hono } from "hono";
import type { AppEnv } from "../types/hono.js";
import { corsMiddleware } from "./middleware/cors.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { apiKeyAuth } from "./middleware/apiKeyAuth.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("http");
import { apiKeyRateLimit } from "./middleware/rateLimit.js";
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
import claims from "./routes/claims.js";
import profiles from "./routes/profiles.js";
import stats from "./routes/stats.js";
import { events } from "./routes/events.js";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Global middleware — requestId must run first so the logger can read it
  app.use("*", corsMiddleware);
  app.use("*", requestIdMiddleware);
  app.use("*", loggerMiddleware);

  // Health stays unauthenticated (monitoring, uptime checks)
  app.route("/health", health);

  // Admin routes — internal auth (API_SECRET_KEY) handled inside admin.ts
  app.route("/admin", admin);

  // Claims router — mounted BEFORE global apiKeyAuth because Path 1 handles its own auth
  // (Path 1 uses Authorization: Bearer <clerk-jwt> which apiKeyAuth would misinterpret as API key)
  app.route("/v1/collections/claim", claims);

  // All /v1/* routes require a tenant API key
  app.use("/v1/*", apiKeyAuth);
  app.use("/v1/*", apiKeyRateLimit());

  // Tenant self-service portal
  app.route("/v1/portal", portal);

  // Existing data routes
  app.route("/v1/orders", orders);
  app.route("/v1/tokens", tokens);
  app.route("/v1", profiles);               // profiles before collections (prevents route shadowing)
  app.route("/v1/collections", collections);
  app.route("/v1/activities", activities);
  app.route("/v1/intents", intents);
  app.route("/v1/metadata", metadata);
  app.route("/v1/search", search);
  app.route("/v1/stats", stats);
  app.route("/v1/events", events);

  // 404 fallback
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  // Global error handler
  app.onError((err, c) => {
    log.error({ err, requestId: c.get("requestId") }, "Unhandled request error");
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
