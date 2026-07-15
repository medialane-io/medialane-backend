-- IP Sponsorship v3 indexing. The issued license is a real ERC-721 on the
-- IPSponsorship contract itself (indexed as a Collection/Token like any
-- other collection); these four tables cover only what doesn't fit that
-- generic shape: the pre-mint offer/bid/proposal lifecycle, and the
-- license-specific facts (expiresAt/transferable/assetContract/assetTokenId)
-- that exist only in the LicenseMinted event, never on-chain state.
-- Hand-written (no local Postgres available at author time); applied via
-- `prisma migrate deploy` on the next Railway deploy, same pattern as
-- 20260702000000_add_ticket_redeemed_and_sponsorship_tables. Spec:
-- medialane-core/docs/plans/2026-07-14-ip-sponsorship-real-world-redesign.md

-- CreateTable
CREATE TABLE "SponsorshipOffer" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "contractAddress" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "nftContract" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "minAmount" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "paymentToken" TEXT NOT NULL,
    "licenseTermsUri" TEXT NOT NULL,
    "transferable" BOOLEAN NOT NULL,
    "royaltyBps" INTEGER NOT NULL,
    "specificSponsor" TEXT,
    "open" BOOLEAN NOT NULL DEFAULT true,
    "createdAtChain" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorshipOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorshipBid" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "contractAddress" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "sponsor" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "placedAtChain" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorshipBid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorshipProposal" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "contractAddress" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "proposer" TEXT NOT NULL,
    "nftContract" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "validUntil" TIMESTAMP(3),
    "paymentToken" TEXT NOT NULL,
    "licenseTermsUri" TEXT NOT NULL,
    "transferable" BOOLEAN NOT NULL,
    "royaltyBps" INTEGER NOT NULL,
    "open" BOOLEAN NOT NULL DEFAULT true,
    "accepted" BOOLEAN,
    "createdAtChain" TIMESTAMP(3) NOT NULL,
    "closedAtChain" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorshipProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorshipLicense" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "contractAddress" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "assetContract" TEXT NOT NULL,
    "assetTokenId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "transferable" BOOLEAN NOT NULL,
    "royaltyBps" INTEGER NOT NULL,
    "licenseTermsUri" TEXT NOT NULL,
    "offerId" TEXT,
    "proposalId" TEXT,
    "mintedAtChain" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorshipLicense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SponsorshipOffer_chain_contractAddress_offerId_key" ON "SponsorshipOffer"("chain", "contractAddress", "offerId");

-- CreateIndex
CREATE INDEX "SponsorshipOffer_chain_contractAddress_open_idx" ON "SponsorshipOffer"("chain", "contractAddress", "open");

-- CreateIndex
CREATE INDEX "SponsorshipOffer_chain_author_idx" ON "SponsorshipOffer"("chain", "author");

-- CreateIndex
CREATE INDEX "SponsorshipOffer_chain_nftContract_tokenId_idx" ON "SponsorshipOffer"("chain", "nftContract", "tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorshipBid_chain_contractAddress_offerId_sponsor_key" ON "SponsorshipBid"("chain", "contractAddress", "offerId", "sponsor");

-- CreateIndex
CREATE INDEX "SponsorshipBid_chain_sponsor_idx" ON "SponsorshipBid"("chain", "sponsor");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorshipProposal_chain_contractAddress_proposalId_key" ON "SponsorshipProposal"("chain", "contractAddress", "proposalId");

-- CreateIndex
CREATE INDEX "SponsorshipProposal_chain_contractAddress_open_idx" ON "SponsorshipProposal"("chain", "contractAddress", "open");

-- CreateIndex
CREATE INDEX "SponsorshipProposal_chain_proposer_idx" ON "SponsorshipProposal"("chain", "proposer");

-- CreateIndex
CREATE INDEX "SponsorshipProposal_chain_nftContract_tokenId_idx" ON "SponsorshipProposal"("chain", "nftContract", "tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorshipLicense_chain_contractAddress_tokenId_key" ON "SponsorshipLicense"("chain", "contractAddress", "tokenId");

-- CreateIndex
CREATE INDEX "SponsorshipLicense_chain_author_idx" ON "SponsorshipLicense"("chain", "author");

-- CreateIndex
CREATE INDEX "SponsorshipLicense_chain_assetContract_assetTokenId_idx" ON "SponsorshipLicense"("chain", "assetContract", "assetTokenId");

-- AddForeignKey
ALTER TABLE "SponsorshipBid" ADD CONSTRAINT "SponsorshipBid_chain_contractAddress_offerId_fkey" FOREIGN KEY ("chain", "contractAddress", "offerId") REFERENCES "SponsorshipOffer"("chain", "contractAddress", "offerId") ON DELETE RESTRICT ON UPDATE CASCADE;
