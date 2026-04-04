-- Add tenantId to TransactionIntent for ownership scoping on PATCH endpoints
ALTER TABLE "TransactionIntent" ADD COLUMN "tenantId" TEXT;
