-- DropIndex
DROP INDEX "Report_targetKey_reporterUserId_key";

-- DropIndex
DROP INDEX "User_clerkUserId_key";

-- DropIndex
DROP INDEX "User_clerkUserId_idx";

-- AlterTable
ALTER TABLE "Report" DROP COLUMN "reporterUserId",
ADD COLUMN     "reporterWallet" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP CONSTRAINT "User_pkey",
DROP COLUMN "clerkUserId",
DROP COLUMN "id",
ADD CONSTRAINT "User_pkey" PRIMARY KEY ("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Report_targetKey_reporterWallet_key" ON "Report"("targetKey", "reporterWallet");
