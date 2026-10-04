ALTER TABLE "Identity" ALTER COLUMN "clientId" SET NOT NULL;
DROP INDEX "Identity_scheme_value_tenantId_key";
DROP INDEX "Identity_tenantId_idx";
ALTER TABLE "Identity" DROP CONSTRAINT "Identity_tenantId_fkey";
ALTER TABLE "Identity" DROP COLUMN "tenantId";
DROP INDEX "ApiKey_tenantId_idx";
ALTER TABLE "ApiKey" DROP CONSTRAINT "ApiKey_tenantId_fkey";
ALTER TABLE "ApiKey" DROP COLUMN "tenantId";
DROP TABLE "Tenant";
