import { Hono } from "hono";
import type { AppEnv } from "../types/hono.js";
import { corsMiddleware } from "./middleware/cors.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { apiKeyGate } from "./middleware/apiKeyGate.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("http");
import health from "./routes/health.js";
import orders from "./routes/orders.js";
import tokens from "./routes/tokens.js";
import collections from "./routes/collections.js";
import activities from "./routes/activities.js";
import intents from "./routes/intents/index.js";
import metadata from "./routes/metadata.js";
import prices from "./routes/prices.js";
import search from "./routes/search.js";
import portal from "./routes/portal.js";
import admin from "./routes/admin/index.js";
import claims from "./routes/claims.js";
import { businessProvisioningRoutes } from "./routes/business-provisioning.js";
import { walletActivityRoutes } from "./routes/wallet-activity.js";
import usernameClaims from "./routes/username-claims.js";
import collectionSlugClaims from "./routes/collection-slug-claims.js";
import users from "./routes/users.js";
import profiles from "./routes/profiles.js";
import stats from "./routes/stats.js";
import { events } from "./routes/events.js";
import reports from "./routes/reports.js";
import remixOffers from "./routes/remix-offers.js";
import pop from "./routes/pop.js";
import tickets from "./routes/tickets-onchain.js";
import club from "./routes/club-onchain.js";
import ipnft from "./routes/ipnft-onchain.js";
import dropOnchain from "./routes/drop-onchain.js";
import rpcMeter from "./routes/rpc-meter.js";
import paymasterMeter from "./routes/paymaster-meter.js";
import swapMeter from "./routes/swap-meter.js";
import coins from "./routes/coins.js";
import drop from "./routes/drop.js";
import siws from "./routes/siws.js";
import { authEmail } from "./routes/auth-email.js";
import { rewards, adminRewards } from "./routes/rewards.js";
import sponsorship from "./routes/sponsorship.js";
import { x402Discovery } from "./routes/x402.js";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", corsMiddleware);
  app.use("*", requestIdMiddleware);
  app.use("*", loggerMiddleware);

  app.route("/health", health);

  app.route("/", x402Discovery);

  app.route("/admin", admin);
  app.route("/admin/rewards", adminRewards);

  app.use("/v1/*", apiKeyGate);

  app.route("/v1/collections/claim", claims);
  app.route("/v1/wallet-activity", walletActivityRoutes);
  app.route("/v1/business/provisioning", businessProvisioningRoutes);
  app.route("/v1/username-claims", usernameClaims);
  app.route("/v1/collection-slug-claims", collectionSlugClaims);
  app.route("/v1/users", users);
  app.route("/v1/remix-offers", remixOffers);

  app.route("/v1/auth/siws", siws);
  app.route("/v1/auth/email", authEmail);

  app.route("/v1/portal", portal);

  app.route("/v1/orders", orders);
  app.route("/v1/tokens", tokens);
  app.route("/v1", profiles);
  app.route("/v1/collections", collections);
  app.route("/v1/coins", coins);
  app.route("/v1/activities", activities);
  app.route("/v1/intents", intents);
  app.route("/v1/metadata", metadata);
  app.route("/v1/prices", prices);
  app.route("/v1/search", search);
  app.route("/v1/stats", stats);
  app.route("/v1/events", events);
  app.route("/v1/reports", reports);
  app.route("/v1/pop", pop);
  app.route("/v1/tickets", tickets);
  app.route("/v1/club", club);
  app.route("/v1/ipnft", ipnft);
  app.route("/v1/drop", drop);
  app.route("/v1/drop", dropOnchain);
  app.route("/v1/rpc", rpcMeter);
  app.route("/v1/paymaster", paymasterMeter);
  app.route("/v1/swap", swapMeter);
  app.route("/v1/sponsorship", sponsorship);
  app.route("/v1/rewards", rewards);

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((err, c) => {
    log.error({ err, requestId: c.get("requestId") }, "Unhandled request error");
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
