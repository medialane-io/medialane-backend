-- Phase D cutover: the Account is the only billing identity (07-identity §III).
-- Pre-verified on a prod-backup restore (2026-07-11 dump): 0 orphan ApiKeys /
-- WebhookEndpoints / Payments, credits conserved (Account total == legacy
-- Tenant total). The SET NOT NULLs below are the structural wall — they fail
-- the deploy if an orphan somehow appeared since.

-- TransactionIntent: scope rows by Account instead of Tenant. Old tenant-scoped
-- values are meaningless under the new key; rows expire within the 24h TTL and
-- a NULL accountId is the documented pre-cutover state (checks pass it).
ALTER TABLE "TransactionIntent" ADD COLUMN "accountId" TEXT;
ALTER TABLE "TransactionIntent" DROP COLUMN "tenantId";

-- ApiKey / WebhookEndpoint / Payment: require the Account link, drop the
-- Tenant link (DROP COLUMN cascades its FK + index).
ALTER TABLE "ApiKey" DROP COLUMN "tenantId";
ALTER TABLE "ApiKey" ALTER COLUMN "accountId" SET NOT NULL;

ALTER TABLE "WebhookEndpoint" DROP COLUMN "tenantId";
ALTER TABLE "WebhookEndpoint" ALTER COLUMN "accountId" SET NOT NULL;

ALTER TABLE "Payment" DROP COLUMN "tenantId";
ALTER TABLE "Payment" ALTER COLUMN "accountId" SET NOT NULL;

-- The Tenant model and its enums are gone.
DROP TABLE "Tenant";
DROP TYPE "TenantPlan";
DROP TYPE "TenantStatus";
