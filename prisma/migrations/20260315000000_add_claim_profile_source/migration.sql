-- CreateEnum
CREATE TYPE "CollectionSource" AS ENUM ('MEDIALANE_REGISTRY', 'EXTERNAL', 'PARTNERSHIP', 'IP_TICKET', 'IP_CLUB', 'GAME');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'AUTO_APPROVED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationMethod" AS ENUM ('ONCHAIN', 'SIGNATURE', 'MANUAL');

-- AlterTable: add source and claimedBy to Collection
ALTER TABLE "Collection" ADD COLUMN "source" "CollectionSource" NOT NULL DEFAULT 'MEDIALANE_REGISTRY';
ALTER TABLE "Collection" ADD COLUMN "claimedBy" TEXT;

-- CreateTable: CollectionProfile
CREATE TABLE "CollectionProfile" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "chain" "Chain" NOT NULL,
    "displayName" TEXT,
    "description" TEXT,
    "image" TEXT,
    "bannerImage" TEXT,
    "websiteUrl" TEXT,
    "twitterUrl" TEXT,
    "discordUrl" TEXT,
    "telegramUrl" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CreatorProfile
CREATE TABLE "CreatorProfile" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "displayName" TEXT,
    "bio" TEXT,
    "avatarImage" TEXT,
    "bannerImage" TEXT,
    "websiteUrl" TEXT,
    "twitterUrl" TEXT,
    "discordUrl" TEXT,
    "telegramUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CollectionClaim
CREATE TABLE "CollectionClaim" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "claimantAddress" TEXT,
    "claimantEmail" TEXT,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "verificationMethod" "VerificationMethod" NOT NULL,
    "notes" TEXT,
    "adminNotes" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ClaimChallenge
CREATE TABLE "ClaimChallenge" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: CollectionProfile unique on (chain, contractAddress)
CREATE UNIQUE INDEX "CollectionProfile_chain_contractAddress_key" ON "CollectionProfile"("chain", "contractAddress");

-- CreateIndex: CreatorProfile unique on walletAddress
CREATE UNIQUE INDEX "CreatorProfile_walletAddress_key" ON "CreatorProfile"("walletAddress");

-- CreateIndex: ClaimChallenge unique on challenge
CREATE UNIQUE INDEX "ClaimChallenge_challenge_key" ON "ClaimChallenge"("challenge");

-- CreateIndex: ClaimChallenge index on (walletAddress, contractAddress)
CREATE INDEX "ClaimChallenge_walletAddress_contractAddress_idx" ON "ClaimChallenge"("walletAddress", "contractAddress");

-- AddForeignKey: CollectionProfile -> Collection
ALTER TABLE "CollectionProfile" ADD CONSTRAINT "CollectionProfile_chain_contractAddress_fkey"
    FOREIGN KEY ("chain", "contractAddress") REFERENCES "Collection"("chain", "contractAddress")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "CollectionClaim_chain_contractAddress_idx" ON "CollectionClaim"("chain", "contractAddress");
CREATE INDEX "CollectionClaim_status_idx" ON "CollectionClaim"("status");
CREATE INDEX "CollectionClaim_chain_claimantAddress_idx" ON "CollectionClaim"("chain", "claimantAddress");
