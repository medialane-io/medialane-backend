-- CreateTable
CREATE TABLE "ApiClient" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "creditBalance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiClient_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "apiClientId" TEXT;

-- AlterTable
ALTER TABLE "BusinessProvisioning" ADD COLUMN     "apiClientId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "apiClientId" TEXT;

-- AlterTable
ALTER TABLE "WebhookEndpoint" ADD COLUMN     "apiClientId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_accountId_key" ON "ApiClient"("accountId");

-- CreateIndex
CREATE INDEX "ApiClient_accountId_idx" ON "ApiClient"("accountId");

-- CreateIndex
CREATE INDEX "ApiKey_apiClientId_idx" ON "ApiKey"("apiClientId");

-- CreateIndex
CREATE INDEX "BusinessProvisioning_apiClientId_idx" ON "BusinessProvisioning"("apiClientId");

-- CreateIndex
CREATE INDEX "Payment_apiClientId_idx" ON "Payment"("apiClientId");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_apiClientId_idx" ON "WebhookEndpoint"("apiClientId");

-- AddForeignKey
ALTER TABLE "ApiClient" ADD CONSTRAINT "ApiClient_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessProvisioning" ADD CONSTRAINT "BusinessProvisioning_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
