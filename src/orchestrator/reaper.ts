import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:reaper");
// Maintenance-only cleanup of records with no read consumers anywhere
// (terminal webhook deliveries, terminal transaction intents, expired claim
// challenges) — not user-facing, so this runs on a slow cadence rather than
// the platform's near-real-time loops. Transfer and Order history are real
// platform data (read by activities.ts/tokens.ts/orders.ts/portal.ts) and
// are never deleted here.
const REAPER_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

const WEBHOOK_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function runReaper(): Promise<void> {
  const { count: deliveriesDeleted } = await prisma.webhookDelivery.deleteMany({
    where: {
      isTerminal: true,
      createdAt: { lt: new Date(Date.now() - WEBHOOK_DELIVERY_TTL_MS) },
    },
  });
  if (deliveriesDeleted > 0) log.info({ count: deliveriesDeleted }, "Reaper: purged old webhook deliveries");

  const { count: intentDeleted } = await prisma.transactionIntent.deleteMany({
    where: {
      status: { in: ["CONFIRMED", "FAILED", "EXPIRED"] },
      updatedAt: { lt: new Date(Date.now() - INTENT_TTL_MS) },
    },
  });
  if (intentDeleted > 0) log.info({ count: intentDeleted }, "Reaper: purged old terminal intents");

  const { count: intentsExpired } = await prisma.transactionIntent.updateMany({
    where: {
      status: { in: ["PENDING", "SIGNED"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "EXPIRED" },
  });
  if (intentsExpired > 0) log.info({ count: intentsExpired }, "Reaper: expired stale transaction intents");

  const { count: offersExpired } = await prisma.remixOffer.updateMany({
    where: {
      status: { in: ["PENDING", "AUTO_PENDING"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "EXPIRED" },
  });
  if (offersExpired > 0) log.info({ count: offersExpired }, "Reaper: expired remix offers");

  const { count: challengesDeleted } = await prisma.claimChallenge.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  if (challengesDeleted > 0) log.info({ count: challengesDeleted }, "Reaper: purged expired claim challenges");
}

export async function startReaper(): Promise<void> {
  log.info("Reaper started");
  while (true) {
    try {
      await runReaper();
    } catch (err) {
      log.error({ err }, "Reaper error");
    }
    await new Promise((resolve) => setTimeout(resolve, REAPER_POLL_INTERVAL_MS));
  }
}
