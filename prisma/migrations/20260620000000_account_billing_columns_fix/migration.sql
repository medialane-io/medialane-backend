-- Fix-forward for 20260619000000, whose generated SQL was regenerated against an
-- already-db-push'd local DB and lost every ADD COLUMN — so prod recorded it
-- "applied" but the Account billing columns / accountId never existed, breaking
-- apiKeyAuth (P2022). This migration adds them, idempotently, so it is safe
-- whether or not any part already exists.

-- Enums (guarded — CREATE TYPE has no IF NOT EXISTS).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Plan') THEN
    CREATE TYPE "Plan" AS ENUM ('FREE', 'PREMIUM');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AccountStatus') THEN
    CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
  END IF;
END $$;

-- Account billing columns.
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "creditBalance" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "plan" "Plan" NOT NULL DEFAULT 'FREE';
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';

-- Child accountId FKs (nullable — dual-read with tenantId).
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "WebhookEndpoint" ADD COLUMN IF NOT EXISTS "accountId" TEXT;

-- Indexes.
CREATE INDEX IF NOT EXISTS "ApiKey_accountId_idx" ON "ApiKey"("accountId");
CREATE INDEX IF NOT EXISTS "Payment_accountId_idx" ON "Payment"("accountId");
CREATE INDEX IF NOT EXISTS "WebhookEndpoint_accountId_idx" ON "WebhookEndpoint"("accountId");

-- Foreign keys (guarded — ADD CONSTRAINT has no IF NOT EXISTS).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ApiKey_accountId_fkey') THEN
    ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_accountId_fkey') THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WebhookEndpoint_accountId_fkey') THEN
    ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
