-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('PERSON', 'AGENT', 'ORGANIZATION', 'PARTNER');

-- CreateEnum
CREATE TYPE "AccountRole" AS ENUM ('CREATOR', 'COLLECTOR', 'ORGANIZATION', 'AGENT', 'PARTNER');

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('WALLET', 'CLERK', 'PRIVY', 'CHIPIPAY', 'EMAIL');

-- AlterTable
ALTER TABLE "UserScore" ADD COLUMN     "accountId" TEXT;

-- AlterTable
ALTER TABLE "UserBadge" ADD COLUMN     "accountId" TEXT;

-- AlterTable
ALTER TABLE "PointEvent" ADD COLUMN     "accountId" TEXT;

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "type" "AccountType" NOT NULL DEFAULT 'PERSON',
    "roles" "AccountRole"[] DEFAULT ARRAY[]::"AccountRole"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "address" TEXT NOT NULL,
    "walletType" "WalletType" NOT NULL DEFAULT 'UNKNOWN',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Identity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "appSource" "AppSource" NOT NULL DEFAULT 'MEDIALANE_DAPP',
    "email" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountProfile" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "displayName" TEXT,
    "bio" TEXT,
    "avatarImage" TEXT,
    "bannerImage" TEXT,
    "websiteUrl" TEXT,
    "twitterUrl" TEXT,
    "discordUrl" TEXT,
    "telegramUrl" TEXT,
    "username" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_publicId_key" ON "Account"("publicId");

-- CreateIndex
CREATE INDEX "Account_type_idx" ON "Account"("type");

-- CreateIndex
CREATE INDEX "Account_createdAt_idx" ON "Account"("createdAt");

-- CreateIndex
CREATE INDEX "Wallet_accountId_idx" ON "Wallet"("accountId");

-- CreateIndex
CREATE INDEX "Wallet_walletType_idx" ON "Wallet"("walletType");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_chain_address_key" ON "Wallet"("chain", "address");

-- CreateIndex
CREATE INDEX "Identity_accountId_idx" ON "Identity"("accountId");

-- CreateIndex
CREATE INDEX "Identity_appSource_idx" ON "Identity"("appSource");

-- CreateIndex
CREATE INDEX "Identity_email_idx" ON "Identity"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Identity_provider_providerUserId_key" ON "Identity"("provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountProfile_accountId_key" ON "AccountProfile"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountProfile_username_key" ON "AccountProfile"("username");

-- CreateIndex
CREATE INDEX "UserScore_accountId_idx" ON "UserScore"("accountId");

-- CreateIndex
CREATE INDEX "UserBadge_accountId_idx" ON "UserBadge"("accountId");

-- CreateIndex
CREATE INDEX "PointEvent_accountId_idx" ON "PointEvent"("accountId");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountProfile" ADD CONSTRAINT "AccountProfile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

