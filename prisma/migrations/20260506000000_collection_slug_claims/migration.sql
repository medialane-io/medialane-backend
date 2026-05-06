-- Add slug field to CollectionProfile
ALTER TABLE "CollectionProfile" ADD COLUMN "slug" TEXT;
ALTER TABLE "CollectionProfile" ADD CONSTRAINT "CollectionProfile_slug_key" UNIQUE ("slug");

-- Create CollectionSlugClaim table
CREATE TABLE "CollectionSlugClaim" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "walletAddress" TEXT NOT NULL,
    "status" "UsernameClaimStatus" NOT NULL DEFAULT 'PENDING',
    "adminNotes" TEXT,
    "notifyEmail" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionSlugClaim_pkey" PRIMARY KEY ("id")
);

-- Create indexes
CREATE INDEX "CollectionSlugClaim_walletAddress_idx" ON "CollectionSlugClaim"("walletAddress");
CREATE INDEX "CollectionSlugClaim_contractAddress_idx" ON "CollectionSlugClaim"("contractAddress");
CREATE INDEX "CollectionSlugClaim_status_idx" ON "CollectionSlugClaim"("status");
CREATE INDEX "CollectionSlugClaim_slug_idx" ON "CollectionSlugClaim"("slug");
