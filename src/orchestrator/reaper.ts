import prisma from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator:reaper");
const REAPER_POLL_INTERVAL_MS = 5 * 60 * 1000;

const TRANSFER_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ORDER_HISTORY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const WEBHOOK_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function runReaper(): Promise<void> {
  const { count: transfersDeleted } = await prisma.transfer.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - TRANSFER_TTL_MS) } },
  });
  if (transfersDeleted > 0) log.info({ count: transfersDeleted }, "Reaper: purged old transfers");

  const { count: ordersDeleted } = await prisma.order.deleteMany({
    where: {
      status: { in: ["FULFILLED", "CANCELLED"] },
      updatedAt: { lt: new Date(Date.now() - ORDER_HISTORY_TTL_MS) },
    },
  });
  if (ordersDeleted > 0) log.info({ count: ordersDeleted }, "Reaper: purged old closed orders");

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

  // Expire PENDING/SIGNED TransactionIntents that passed their expiresAt
  const { count: intentsExpired } = await prisma.transactionIntent.updateMany({
    where: {
      status: { in: ["PENDING", "SIGNED"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "EXPIRED" },
  });
  if (intentsExpired > 0) log.info({ count: intentsExpired }, "Reaper: expired stale transaction intents");

  // Expire remix offers that passed their expiresAt
  const { count: offersExpired } = await prisma.remixOffer.updateMany({
    where: {
      status: { in: ["PENDING", "AUTO_PENDING"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "EXPIRED" },
  });
  if (offersExpired > 0) log.info({ count: offersExpired }, "Reaper: expired remix offers");

  // Delete expired ClaimChallenges (one-time nonces — no status field, just TTL)
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
