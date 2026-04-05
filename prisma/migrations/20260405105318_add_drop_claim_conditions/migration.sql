CREATE TABLE "DropClaimConditions" (
    "id" SERIAL NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "collectionAddress" TEXT NOT NULL,
    "maxSupply" TEXT NOT NULL,
    "price" TEXT NOT NULL DEFAULT '0',
    "paymentToken" TEXT NOT NULL DEFAULT '0x0',
    "startTime" BIGINT NOT NULL,
    "endTime" BIGINT NOT NULL,
    "maxPerWallet" TEXT NOT NULL DEFAULT '1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DropClaimConditions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DropClaimConditions_chain_collectionAddress_key"
    ON "DropClaimConditions"("chain", "collectionAddress");
