-- IP-Tickets: redeemed flag (contract-side redeem_ticket) + IP-Sponsorship:
-- Offer/Bid/License tables. Sponsorship has no factory and mints nothing
-- itself, so these are NOT Collection/Token rows.
-- Hand-written (local Postgres unavailable at author time); applied in prod
-- via `prisma migrate deploy`. Spec:
-- medialane-core/docs/specs/2026-07-02-launchpad-tickets-club-sponsorship-design.md

-- AlterTable
ALTER TABLE "Token" ADD COLUMN "redeemed" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum
CREATE TYPE "SponsorshipBidStatus" AS ENUM ('ACTIVE', 'RETRACTED', 'ACCEPTED');

-- CreateTable
CREATE TABLE "SponsorshipOffer" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "sponsorshipContract" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "nftContract" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "minAmount" TEXT NOT NULL,
    "duration" BIGINT NOT NULL,
    "paymentToken" TEXT NOT NULL,
    "licenseTermsUri" TEXT NOT NULL,
    "transferable" BOOLEAN NOT NULL,
    "specificSponsor" TEXT,
    "open" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorshipOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorshipBid" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "sponsorshipContract" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "sponsor" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "status" "SponsorshipBidStatus" NOT NULL DEFAULT 'ACTIVE',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorshipBid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorshipLicense" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "sponsorshipContract" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "sponsor" TEXT NOT NULL,
    "transferable" BOOLEAN NOT NULL,
    "expiresAt" BIGINT NOT NULL,
    "licenseNftContract" TEXT,
    "licenseNftTokenId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SponsorshipLicense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SponsorshipOffer_chain_sponsorshipContract_offerId_key" ON "SponsorshipOffer"("chain", "sponsorshipContract", "offerId");

-- CreateIndex
CREATE INDEX "SponsorshipOffer_chain_nftContract_idx" ON "SponsorshipOffer"("chain", "nftContract");

-- CreateIndex
CREATE INDEX "SponsorshipOffer_chain_author_idx" ON "SponsorshipOffer"("chain", "author");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorshipBid_chain_sponsorshipContract_offerId_sponsor_key" ON "SponsorshipBid"("chain", "sponsorshipContract", "offerId", "sponsor");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorshipLicense_chain_sponsorshipContract_licenseId_key" ON "SponsorshipLicense"("chain", "sponsorshipContract", "licenseId");

-- AddForeignKey
ALTER TABLE "SponsorshipBid" ADD CONSTRAINT "SponsorshipBid_chain_sponsorshipContract_offerId_fkey" FOREIGN KEY ("chain", "sponsorshipContract", "offerId") REFERENCES "SponsorshipOffer"("chain", "sponsorshipContract", "offerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorshipLicense" ADD CONSTRAINT "SponsorshipLicense_chain_sponsorshipContract_offerId_fkey" FOREIGN KEY ("chain", "sponsorshipContract", "offerId") REFERENCES "SponsorshipOffer"("chain", "sponsorshipContract", "offerId") ON DELETE RESTRICT ON UPDATE CASCADE;
