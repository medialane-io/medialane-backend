import { Hono } from "hono";
import { corsMiddleware } from "./middleware/cors.js";
import { loggerMiddleware } from "./middleware/logger.js";
import health from "./routes/health.js";
import orders from "./routes/orders.js";
import tokens from "./routes/tokens.js";
import collections from "./routes/collections.js";
import activities from "./routes/activities.js";
import intents from "./routes/intents.js";
import metadata from "./routes/metadata.js";
import search from "./routes/search.js";

export function createApp(): Hono {
  const app = new Hono();

  // Global middleware
  app.use("*", corsMiddleware);
  app.use("*", loggerMiddleware);

  // Routes
  app.route("/health", health);
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
