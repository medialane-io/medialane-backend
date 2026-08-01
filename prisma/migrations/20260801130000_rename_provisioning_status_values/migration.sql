-- Rename ProvisioningStatus enum values to read better for the business-facing
-- console: PROVISIONED -> DEPLOYED, CLAIM_PENDING -> HANDOFF, CLAIMED -> TRANSFERRED.
-- ALTER TYPE ... RENAME VALUE preserves every existing row's data in place.
ALTER TYPE "ProvisioningStatus" RENAME VALUE 'PROVISIONED' TO 'DEPLOYED';
ALTER TYPE "ProvisioningStatus" RENAME VALUE 'CLAIM_PENDING' TO 'HANDOFF';
ALTER TYPE "ProvisioningStatus" RENAME VALUE 'CLAIMED' TO 'TRANSFERRED';
