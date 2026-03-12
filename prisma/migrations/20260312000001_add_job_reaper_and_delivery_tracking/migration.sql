-- Add reaperAttempts to Job (used by the dead-letter reaper to limit re-queues)
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "reaperAttempts" INTEGER NOT NULL DEFAULT 0;

-- Add attemptCount and isTerminal to WebhookDelivery (delivery attempt tracking)
ALTER TABLE "WebhookDelivery" ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WebhookDelivery" ADD COLUMN IF NOT EXISTS "isTerminal" BOOLEAN NOT NULL DEFAULT false;
