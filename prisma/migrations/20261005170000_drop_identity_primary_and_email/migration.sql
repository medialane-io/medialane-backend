-- DropIndex
DROP INDEX "Identity_email_idx";

-- AlterTable
ALTER TABLE "Identity" DROP COLUMN "email",
DROP COLUMN "isPrimary";

