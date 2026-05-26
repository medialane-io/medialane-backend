-- AirdropSignup: captures the io /airdrop form submissions. Replaces the
-- console.log stub that was throwing every signup into stdout.

CREATE TABLE "AirdropSignup" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AirdropSignup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AirdropSignup_email_key" ON "AirdropSignup"("email");
CREATE INDEX "AirdropSignup_role_idx" ON "AirdropSignup"("role");
CREATE INDEX "AirdropSignup_createdAt_idx" ON "AirdropSignup"("createdAt");
