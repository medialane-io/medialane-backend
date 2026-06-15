-- CreateTable
CREATE TABLE "DropPhaseSchedule" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "collectionAddress" TEXT NOT NULL,
    "publicStartTime" BIGINT NOT NULL,
    "publicEndTime" BIGINT NOT NULL,
    "publicPrice" TEXT NOT NULL DEFAULT '0',
    "publicPaymentToken" TEXT NOT NULL DEFAULT '0x0',
    "publicMaxPerWallet" TEXT NOT NULL DEFAULT '1',
    "transitionAt" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DropPhaseSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DropPhaseSchedule_chain_collectionAddress_key" ON "DropPhaseSchedule"("chain", "collectionAddress");
