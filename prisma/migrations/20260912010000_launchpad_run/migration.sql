-- CreateTable
CREATE TABLE "LaunchpadRun" (
    "id" TEXT NOT NULL,
    "apiClientId" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL,
    "quotedAtomic" TEXT NOT NULL,
    "paidAtomic" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LaunchpadRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LaunchpadRun_txHash_key" ON "LaunchpadRun"("txHash");

-- CreateIndex
CREATE INDEX "LaunchpadRun_apiClientId_idx" ON "LaunchpadRun"("apiClientId");

-- AddForeignKey
ALTER TABLE "LaunchpadRun" ADD CONSTRAINT "LaunchpadRun_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
