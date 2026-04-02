-- CreateEnum
CREATE TYPE "RemixOfferStatus" AS ENUM ('PENDING', 'AUTO_PENDING', 'APPROVED', 'COMPLETED', 'REJECTED', 'EXPIRED', 'SELF_MINTED');

-- CreateTable
CREATE TABLE "RemixOffer" (
    "id" TEXT NOT NULL,
    "status" "RemixOfferStatus" NOT NULL DEFAULT 'PENDING',
    "originalContract" TEXT NOT NULL,
    "originalTokenId" TEXT NOT NULL,
    "creatorAddress" TEXT NOT NULL,
    "requesterAddress" TEXT,
    "message" TEXT,
    "proposedPrice" TEXT NOT NULL,
    "proposedCurrency" TEXT NOT NULL,
    "licenseType" TEXT NOT NULL,
    "commercial" BOOLEAN NOT NULL DEFAULT false,
    "derivatives" BOOLEAN NOT NULL DEFAULT true,
    "royaltyPct" INTEGER,
    "approvedCollection" TEXT,
    "remixContract" TEXT,
    "remixTokenId" TEXT,
    "orderHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemixOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RemixOffer_orderHash_idx" ON "RemixOffer"("orderHash");

-- CreateIndex
CREATE INDEX "RemixOffer_originalContract_originalTokenId_idx" ON "RemixOffer"("originalContract", "originalTokenId");

-- CreateIndex
CREATE INDEX "RemixOffer_creatorAddress_idx" ON "RemixOffer"("creatorAddress");

-- CreateIndex
CREATE INDEX "RemixOffer_requesterAddress_idx" ON "RemixOffer"("requesterAddress");
