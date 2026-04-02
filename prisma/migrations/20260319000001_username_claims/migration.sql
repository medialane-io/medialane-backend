-- Add username slug to CreatorProfile (set by admin on claim approval)
ALTER TABLE "CreatorProfile" ADD COLUMN "username" TEXT;
CREATE UNIQUE INDEX "CreatorProfile_username_key" ON "CreatorProfile"("username");

-- Enum for username claim lifecycle
CREATE TYPE "UsernameClaimStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- Username claim requests — reviewed and approved by Medialane DAO team
CREATE TABLE "UsernameClaim" (
    "id"            TEXT NOT NULL,
    "username"      TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "status"        "UsernameClaimStatus" NOT NULL DEFAULT 'PENDING',
    "adminNotes"    TEXT,
    "reviewedAt"    TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsernameClaim_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UsernameClaim_walletAddress_idx" ON "UsernameClaim"("walletAddress");
CREATE INDEX "UsernameClaim_status_idx"        ON "UsernameClaim"("status");
CREATE INDEX "UsernameClaim_username_idx"      ON "UsernameClaim"("username");
