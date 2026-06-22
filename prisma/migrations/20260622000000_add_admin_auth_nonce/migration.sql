-- CreateTable
CREATE TABLE "AdminAuthNonce" (
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminAuthNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE INDEX "AdminAuthNonce_expiresAt_idx" ON "AdminAuthNonce"("expiresAt");
