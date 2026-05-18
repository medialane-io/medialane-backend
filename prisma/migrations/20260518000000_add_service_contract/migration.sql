-- CreateTable
CREATE TABLE "ServiceContract" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "startBlock" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceContract_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceContract_serviceId_idx" ON "ServiceContract"("serviceId");

-- CreateIndex
CREATE INDEX "ServiceContract_chain_active_idx" ON "ServiceContract"("chain", "active");
