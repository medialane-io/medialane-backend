import { Hono } from "hono";
import { z } from "zod";
import { authMiddleware } from "../../middleware/adminSecretAuth.js";
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
import { pollCollectionCreatedEvents, pollTransferEvents, getLatestBlock } from "../../../mirror/poller.js";
import { dispatchTransfer } from "../../../mirror/handlers/transfer.js";
import { parseEvents } from "../../../mirror/parser.js";
import { fetchMarketplaceReceiptEvents, fetchReceiptEvents } from "../../../utils/txVerifier.js";
import { ORDER_CREATED_SELECTOR, ZERO_ADDRESS, getTokenByAddress } from "../../../config/constants.js";
import { num } from "starknet";
import type { ParsedTransfer, ParsedTransferBatch, ParsedTransferSingle } from "../../../types/marketplace.js";

import { InMemoryRateLimitStore } from "../../middleware/rateLimit.js";
import { toErrorMessage } from "../../../utils/error.js";
import { getClientIp } from "./_shared.js";
import { registerTenantRoutes } from "./tenants.js";
import { registerCollectionRoutes } from "./collections.js";
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

// All admin routes require the admin secret + IP-based rate limit
admin.use("*", authMiddleware);
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
registerTenantRoutes(admin);
registerAccountRoutes(admin);
registerCollectionRoutes(admin);
registerClaimRoutes(admin);
registerMarketplaceOpsRoutes(admin);
registerModerationRoutes(admin);
registerServicesRoutes(admin);

export default admin;
