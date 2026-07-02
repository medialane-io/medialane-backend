import { Hono } from "hono";
import type { AppEnv } from "../types/hono.js";
import { corsMiddleware } from "./middleware/cors.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { tenantGate } from "./middleware/tenantGate.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("http");
import health from "./routes/health.js";
import orders from "./routes/orders.js";
import tokens from "./routes/tokens.js";
import collections from "./routes/collections.js";
import activities from "./routes/activities.js";
import intents from "./routes/intents/index.js";
import metadata from "./routes/metadata.js";
import search from "./routes/search.js";
import portal from "./routes/portal.js";
import admin from "./routes/admin/index.js";
import claims from "./routes/claims.js";
import usernameClaims from "./routes/username-claims.js";
import collectionSlugClaims from "./routes/collection-slug-claims.js";
import users from "./routes/users.js";
import profiles from "./routes/profiles.js";
import stats from "./routes/stats.js";
import { events } from "./routes/events.js";
import reports from "./routes/reports.js";
import remixOffers from "./routes/remix-offers.js";
import pop from "./routes/pop.js";
import coins from "./routes/coins.js";
import drop from "./routes/drop.js";
import tickets from "./routes/tickets.js";
import club from "./routes/club.js";
import sponsorship from "./routes/sponsorship.js";
import siws from "./routes/siws.js";
import { rewards, adminRewards } from "./routes/rewards.js";
import { x402Discovery } from "./routes/x402.js";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Global middleware — requestId must run first so the logger can read it
  app.use("*", corsMiddleware);
  app.use("*", requestIdMiddleware);
  app.use("*", loggerMiddleware);

  // Health stays unauthenticated (monitoring, uptime checks)
  app.route("/health", health);

  // x402 payment discovery — public (agents read pricing before holding a key)
  app.route("/", x402Discovery);

  // Admin routes — internal auth (API_SECRET_KEY) handled inside admin.ts
  app.route("/admin", admin);
  app.route("/admin/rewards", adminRewards);

  // All /v1/* routes require a tenant API key (auth, FREE-tier quota, x402
  // metering) except the explicit public paths listed inside tenantGate
  // itself. Mounted FIRST on /v1/* so gating no longer depends on the order
  // routers are registered below — see
  // medialane-core/docs/specs/2026-06-30-tenant-gate-global-middleware-design.md.
  app.use("/v1/*", tenantGate);

  // Claims routers — some routes (e.g. the /check/:x availability checks,
  // /v1/users/me) are exempted inside tenantGate; everything else here is
  // tenant-gated by the mount above, then layers its own Clerk JWT/SIWS auth.
  app.route("/v1/collections/claim", claims);
  app.route("/v1/username-claims", usernameClaims);
  app.route("/v1/collection-slug-claims", collectionSlugClaims);
  app.route("/v1/users", users);
  app.route("/v1/remix-offers", remixOffers);

  // SIWS auth — public, no API key required (authentication precedes key issuance)
  app.route("/v1/auth/siws", siws);

  // Tenant self-service portal
  app.route("/v1/portal", portal);

  // Existing data routes
  app.route("/v1/orders", orders);
  app.route("/v1/tokens", tokens);
  app.route("/v1", profiles);               // profiles before collections (prevents route shadowing)
  app.route("/v1/collections", collections);
  app.route("/v1/coins", coins);
  app.route("/v1/activities", activities);
  app.route("/v1/intents", intents);
  app.route("/v1/metadata", metadata);
  app.route("/v1/search", search);
  app.route("/v1/stats", stats);
  app.route("/v1/events", events);
  app.route("/v1/reports", reports);
  app.route("/v1/pop", pop);
  app.route("/v1/drop", drop);
  app.route("/v1/tickets", tickets);
  app.route("/v1/club", club);
  app.route("/v1/sponsorship", sponsorship);
  app.route("/v1/rewards", rewards);

  // 404 fallback
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  // Global error handler
  app.onError((err, c) => {
    log.error({ err, requestId: c.get("requestId") }, "Unhandled request error");
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
