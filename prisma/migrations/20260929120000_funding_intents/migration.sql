-- Funding intents: the account is fixed when a funding starts, never guessed from the payer.
-- Additive only.

CREATE TYPE "FundingIntentStatus" AS ENUM ('PENDING', 'SETTLED', 'FAILED', 'EXPIRED');

CREATE TABLE "FundingIntent" (
    "id" TEXT NOT NULL,
    "apiClientId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" "FundingIntentStatus" NOT NULL DEFAULT 'PENDING',
    "payer" TEXT,
    "params" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingIntent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FundingIntent_apiClientId_status_idx" ON "FundingIntent"("apiClientId", "status");
CREATE INDEX "FundingIntent_payer_status_idx" ON "FundingIntent"("payer", "status");
CREATE INDEX "FundingIntent_status_expiresAt_idx" ON "FundingIntent"("status", "expiresAt");

ALTER TABLE "FundingIntent" ADD CONSTRAINT "FundingIntent_apiClientId_fkey"
    FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Payment" ADD COLUMN "fundingIntentId" TEXT;
CREATE UNIQUE INDEX "Payment_fundingIntentId_key" ON "Payment"("fundingIntentId");
CREATE INDEX "Payment_payer_idx" ON "Payment"("payer");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_fundingIntentId_fkey"
    FOREIGN KEY ("fundingIntentId") REFERENCES "FundingIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
