-- ApiClient holds a client's credit balance and its key, so it is named ApiCredits.
-- Only names change; no row is touched.

ALTER TABLE "ApiClient" RENAME TO "ApiCredits";

ALTER TABLE "ApiKey" RENAME COLUMN "apiClientId" TO "apiCreditsId";
ALTER TABLE "FundingIntent" RENAME COLUMN "apiClientId" TO "apiCreditsId";
ALTER TABLE "LaunchpadRun" RENAME COLUMN "apiClientId" TO "apiCreditsId";
ALTER TABLE "Payment" RENAME COLUMN "apiClientId" TO "apiCreditsId";
ALTER TABLE "UsageEvent" RENAME COLUMN "apiClientId" TO "apiCreditsId";
ALTER TABLE "WebhookEndpoint" RENAME COLUMN "apiClientId" TO "apiCreditsId";

ALTER TABLE "ApiCredits" RENAME CONSTRAINT "ApiClient_pkey" TO "ApiCredits_pkey";
ALTER TABLE "ApiCredits" RENAME CONSTRAINT "ApiClient_accountId_fkey" TO "ApiCredits_accountId_fkey";
ALTER TABLE "ApiKey" RENAME CONSTRAINT "ApiKey_apiClientId_fkey" TO "ApiKey_apiCreditsId_fkey";
ALTER TABLE "FundingIntent" RENAME CONSTRAINT "FundingIntent_apiClientId_fkey" TO "FundingIntent_apiCreditsId_fkey";
ALTER TABLE "LaunchpadRun" RENAME CONSTRAINT "LaunchpadRun_apiClientId_fkey" TO "LaunchpadRun_apiCreditsId_fkey";
ALTER TABLE "Payment" RENAME CONSTRAINT "Payment_apiClientId_fkey" TO "Payment_apiCreditsId_fkey";
ALTER TABLE "UsageEvent" RENAME CONSTRAINT "UsageEvent_apiClientId_fkey" TO "UsageEvent_apiCreditsId_fkey";
ALTER TABLE "WebhookEndpoint" RENAME CONSTRAINT "WebhookEndpoint_apiClientId_fkey" TO "WebhookEndpoint_apiCreditsId_fkey";

ALTER INDEX "ApiClient_accountId_idx" RENAME TO "ApiCredits_accountId_idx";
ALTER INDEX "ApiClient_accountId_key" RENAME TO "ApiCredits_accountId_key";
ALTER INDEX "ApiKey_apiClientId_key" RENAME TO "ApiKey_apiCreditsId_key";
ALTER INDEX "FundingIntent_apiClientId_status_idx" RENAME TO "FundingIntent_apiCreditsId_status_idx";
ALTER INDEX "LaunchpadRun_apiClientId_status_idx" RENAME TO "LaunchpadRun_apiCreditsId_status_idx";
ALTER INDEX "Payment_apiClientId_idx" RENAME TO "Payment_apiCreditsId_idx";
ALTER INDEX "UsageEvent_apiClientId_createdAt_idx" RENAME TO "UsageEvent_apiCreditsId_createdAt_idx";
ALTER INDEX "WebhookEndpoint_apiClientId_idx" RENAME TO "WebhookEndpoint_apiCreditsId_idx";
