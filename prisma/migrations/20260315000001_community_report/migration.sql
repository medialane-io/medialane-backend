-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('COLLECTION', 'TOKEN', 'CREATOR');

-- CreateEnum
CREATE TYPE "ReportCategory" AS ENUM ('COPYRIGHT_PIRACY', 'VIOLENCE_GRAPHIC', 'HATE_SPEECH', 'SCAM_FRAUD', 'SPAM', 'NSFW', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'HIDDEN', 'DISMISSED', 'RESTORED');

-- AlterTable: add isHidden to Collection
ALTER TABLE "Collection" ADD COLUMN "isHidden" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: add isHidden to Token
ALTER TABLE "Token" ADD COLUMN "isHidden" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: Report
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "targetType" "ReportTargetType" NOT NULL,
    "targetKey" TEXT NOT NULL,
    "targetContract" TEXT,
    "targetTokenId" TEXT,
    "targetAddress" TEXT,
    "reporterUserId" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "categories" "ReportCategory"[],
    "description" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "adminNotes" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable: HiddenCreator
CREATE TABLE "HiddenCreator" (
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "address" TEXT NOT NULL,
    "hiddenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HiddenCreator_pkey" PRIMARY KEY ("chain","address")
);

-- CreateIndex
CREATE UNIQUE INDEX "Report_targetKey_reporterUserId_key" ON "Report"("targetKey", "reporterUserId");

-- CreateIndex
CREATE INDEX "Report_status_idx" ON "Report"("status");

-- CreateIndex
CREATE INDEX "Report_targetType_targetKey_idx" ON "Report"("targetType", "targetKey");

-- CreateIndex
CREATE INDEX "Report_createdAt_idx" ON "Report"("createdAt");
