-- Drop tables that accumulate unboundedly (replaced by in-process/in-memory alternatives)
DROP TABLE IF EXISTS "Job";
DROP TABLE IF EXISTS "MetadataCache";
DROP TABLE IF EXISTS "UsageLog";
DROP TABLE IF EXISTS "AuditLog";

-- Drop enums that belonged to the Job table
DROP TYPE IF EXISTS "JobType";
DROP TYPE IF EXISTS "JobStatus";

-- Remove jobId from WebhookDelivery (no longer needed without Job table)
ALTER TABLE "WebhookDelivery" DROP COLUMN IF EXISTS "jobId";

-- Add monthly quota tracking directly on ApiKey (replaces UsageLog count)
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "monthlyRequestCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "monthlyResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
