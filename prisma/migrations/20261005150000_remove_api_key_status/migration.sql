-- A key that is revoked no longer exists, so dropping the status must never make one usable.
DELETE FROM "ApiKey" WHERE "status" = 'REVOKED';

-- DropIndex
DROP INDEX "ApiKey_status_idx";

-- AlterTable
ALTER TABLE "ApiKey" DROP COLUMN "status";

-- DropEnum
DROP TYPE "ApiKeyStatus";
