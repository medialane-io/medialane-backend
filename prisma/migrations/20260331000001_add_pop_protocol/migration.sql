-- Add POP_PROTOCOL to CollectionSource enum
ALTER TYPE "CollectionSource" ADD VALUE 'POP_PROTOCOL';

-- Create PopAllowlist table
CREATE TABLE "PopAllowlist" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "collectionAddress" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PopAllowlist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PopAllowlist_chain_collectionAddress_walletAddress_key"
    ON "PopAllowlist"("chain", "collectionAddress", "walletAddress");

CREATE INDEX "PopAllowlist_chain_collectionAddress_idx"
    ON "PopAllowlist"("chain", "collectionAddress");
