-- CreateEnum
CREATE TYPE "LaunchpadRunStatus" AS ENUM ('DRAFT', 'PAID', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "LaunchpadRun" (
    "id" TEXT NOT NULL,
    "apiClientId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "status" "LaunchpadRunStatus" NOT NULL DEFAULT 'DRAFT',
    "spec" JSONB NOT NULL,
    "quote" JSONB,
    "creditsHeld" INTEGER NOT NULL DEFAULT 0,
    "creditsSpent" INTEGER NOT NULL DEFAULT 0,
    "paymentId" TEXT,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LaunchpadRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LaunchpadRun_paymentId_key" ON "LaunchpadRun"("paymentId");

-- CreateIndex
CREATE INDEX "LaunchpadRun_apiClientId_status_idx" ON "LaunchpadRun"("apiClientId", "status");

-- AddForeignKey
ALTER TABLE "LaunchpadRun" ADD CONSTRAINT "LaunchpadRun_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
