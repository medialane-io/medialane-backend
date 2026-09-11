-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "apiClientId" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "unitCredits" INTEGER NOT NULL,
    "units" INTEGER NOT NULL,
    "credits" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageEvent_apiClientId_createdAt_idx" ON "UsageEvent"("apiClientId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_actionKey_idx" ON "UsageEvent"("actionKey");

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
