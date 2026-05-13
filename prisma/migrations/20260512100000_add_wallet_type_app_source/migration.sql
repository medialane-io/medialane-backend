-- CreateEnum
CREATE TYPE "WalletType" AS ENUM ('ARGENT', 'BRAAVOS', 'CARTRIDGE', 'PRIVY', 'CHIPIPAY', 'INJECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AppSource" AS ENUM ('MEDIALANE_DAPP', 'MEDIALANE_IO', 'MEDIALANE_PORTAL', 'MEDIALANE_SDK');

-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
  ADD COLUMN "walletType" "WalletType" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "appSource" "AppSource" NOT NULL DEFAULT 'MEDIALANE_DAPP';

-- CreateIndex
CREATE INDEX "User_chain_idx" ON "User"("chain");

-- CreateIndex
CREATE INDEX "User_appSource_idx" ON "User"("appSource");

-- CreateIndex
CREATE INDEX "User_walletType_idx" ON "User"("walletType");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");
