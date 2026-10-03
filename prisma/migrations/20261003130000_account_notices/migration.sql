-- CreateTable
CREATE TABLE "AccountNotice" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountNotice_kind_createdAt_idx" ON "AccountNotice"("kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountNotice_accountId_kind_key" ON "AccountNotice"("accountId", "kind");

-- AddForeignKey
ALTER TABLE "AccountNotice" ADD CONSTRAINT "AccountNotice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
