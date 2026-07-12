import { Hono } from "hono";
import { z } from "zod";
import { adminAuth } from "../../middleware/adminAuth.js";
import prisma from "../../../db/client.js";
import { generateApiKey } from "../../../utils/apiKey.js";
import { handleMetadataFetch } from "../../../orchestrator/metadata.js";
import { handleCollectionMetadataFetch } from "../../../orchestrator/collectionMetadata.js";
import { handleStatsUpdate } from "../../../orchestrator/stats.js";
import { runTransferFollowups } from "../../../orchestrator/transferFollowup.js";
import { worker } from "../../../orchestrator/worker.js";
import { createLogger } from "../../../utils/logger.js";
import { sendUsernameClaimApproved, sendUsernameClaimRejected } from "../../../utils/mailer.js";
import { normalizeAddress, normalizeHash } from "../../../utils/starknet.js";
import { handleOrderCreated, handleOrderCreated1155 } from "../../../mirror/handlers/orderCreated.js";
import { dispatchTransfer } from "../../../mirror/handlers/transfer.js";
import { parseEvents } from "../../../mirror/parser.js";
import { fetchMarketplaceReceiptEvents, fetchReceiptEvents } from "../../../utils/txVerifier.js";
import { ORDER_CREATED_SELECTOR, ZERO_ADDRESS, getTokenByAddress } from "../../../config/constants.js";
import { num } from "starknet";
import type { ParsedTransfer, ParsedTransferBatch, ParsedTransferSingle } from "../../../types/marketplace.js";

import { InMemoryRateLimitStore } from "../../middleware/rateLimit.js";
import { toErrorMessage } from "../../../utils/error.js";
import { getClientIp } from "./_shared.js";
import { registerCollectionRoutes } from "./collections.js";
import { registerTokenOpsRoutes } from "./token-ops.js";
import { registerCoinRoutes } from "./coins.js";
import { registerClaimRoutes } from "./claims.js";
import { registerMarketplaceOpsRoutes } from "./marketplace-ops.js";
import { registerModerationRoutes } from "./moderation.js";
import { registerServicesRoutes } from "./services.js";
import { registerAccountRoutes } from "./accounts.js";

const log = createLogger("routes:admin");
const admin = new Hono();

// Simple IP-based rate limiter for admin routes (20 req/min per IP)
const adminRateLimitStore = new InMemoryRateLimitStore();
const ADMIN_RATE_LIMIT = 20;
const ADMIN_WINDOW_MS = 60_000;

// All admin routes require admin auth + IP-based rate limit. adminAuth accepts
// EITHER signed-request auth (x-ml-admin-* headers; browsers/agents) OR the
// master key / scoped PORTAL_SERVICE_SECRET (CLI/scripts; the latter only on
// /admin/accounts/*). Server-to-server callers are unchanged.
admin.use("*", adminAuth);
admin.use("*", async (c, next) => {
  const ip = getClientIp(c);
  const { count, resetAt } = await adminRateLimitStore.increment(`admin:${ip}`, ADMIN_WINDOW_MS);
  if (count > ADMIN_RATE_LIMIT) {
    c.header("Retry-After", String(Math.ceil((resetAt - Date.now()) / 1000)));
    return c.json({ error: "Too many requests" }, 429);
  }
  await next();
});

// Domain route registrars — same `admin` instance, original registration order.
registerAccountRoutes(admin);
registerCollectionRoutes(admin);
registerTokenOpsRoutes(admin);
registerCoinRoutes(admin);
registerClaimRoutes(admin);
registerMarketplaceOpsRoutes(admin);
registerModerationRoutes(admin);
registerServicesRoutes(admin);

export default admin;
