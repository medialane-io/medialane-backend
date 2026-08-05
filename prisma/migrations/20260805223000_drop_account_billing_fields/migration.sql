-- DropForeignKey
ALTER TABLE "ApiKey" DROP CONSTRAINT "ApiKey_accountId_fkey";

-- DropForeignKey
ALTER TABLE "BusinessProvisioning" DROP CONSTRAINT "BusinessProvisioning_accountId_fkey";

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_accountId_fkey";

-- DropForeignKey
ALTER TABLE "WebhookEndpoint" DROP CONSTRAINT "WebhookEndpoint_accountId_fkey";

-- DropIndex
DROP INDEX "ApiKey_accountId_idx";

-- DropIndex
DROP INDEX "BusinessProvisioning_accountId_status_idx";

-- DropIndex
DROP INDEX "BusinessProvisioning_apiClientId_idx";

-- DropIndex
DROP INDEX "Payment_accountId_idx";

-- DropIndex
DROP INDEX "WebhookEndpoint_accountId_idx";

-- AlterTable
ALTER TABLE "Account" DROP COLUMN "creditBalance",
DROP COLUMN "plan";

-- AlterTable
ALTER TABLE "ApiKey" DROP COLUMN "accountId",
ALTER COLUMN "apiClientId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BusinessProvisioning" DROP COLUMN "accountId",
ALTER COLUMN "apiClientId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "accountId",
ALTER COLUMN "apiClientId" SET NOT NULL;

-- AlterTable
ALTER TABLE "WebhookEndpoint" DROP COLUMN "accountId",
ALTER COLUMN "apiClientId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "BusinessProvisioning_apiClientId_status_idx" ON "BusinessProvisioning"("apiClientId", "status");
