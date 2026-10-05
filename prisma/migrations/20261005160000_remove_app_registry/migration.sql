-- DropForeignKey
ALTER TABLE "Identity" DROP CONSTRAINT "Identity_app_fkey";

-- DropForeignKey
ALTER TABLE "App" DROP CONSTRAINT "App_clientId_fkey";

-- DropIndex
DROP INDEX "Identity_app_idx";

-- AlterTable
ALTER TABLE "Identity" DROP COLUMN "app";

-- DropTable
DROP TABLE "App";

