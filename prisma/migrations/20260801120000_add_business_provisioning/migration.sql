-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('PROVISIONED', 'CLAIM_PENDING', 'CLAIMED');

-- CreateTable
CREATE TABLE "BusinessProvisioning" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "walletAddress" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "interimOwnerPubkey" TEXT NOT NULL,
    "newOwnerPubkey" TEXT,
    "status" "ProvisioningStatus" NOT NULL DEFAULT 'PROVISIONED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProvisioning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisioningClaimToken" (
    "id" TEXT NOT NULL,
    "provisioningId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProvisioningClaimToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessProvisioning_accountId_status_idx" ON "BusinessProvisioning"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProvisioning_chain_walletAddress_key" ON "BusinessProvisioning"("chain", "walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "ProvisioningClaimToken_token_key" ON "ProvisioningClaimToken"("token");

-- CreateIndex
CREATE INDEX "ProvisioningClaimToken_provisioningId_idx" ON "ProvisioningClaimToken"("provisioningId");

-- AddForeignKey
ALTER TABLE "BusinessProvisioning" ADD CONSTRAINT "BusinessProvisioning_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisioningClaimToken" ADD CONSTRAINT "ProvisioningClaimToken_provisioningId_fkey" FOREIGN KEY ("provisioningId") REFERENCES "BusinessProvisioning"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

