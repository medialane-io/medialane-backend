-- CreateTable
CREATE TABLE "SiwsNonce" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiwsNonce_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiwsNonce_nonce_key" ON "SiwsNonce"("nonce");

-- CreateIndex
CREATE INDEX "SiwsNonce_walletAddress_idx" ON "SiwsNonce"("walletAddress");
