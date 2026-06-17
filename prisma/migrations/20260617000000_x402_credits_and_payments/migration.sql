-- x402 agent payments: per-tenant credit balance + payment ledger.
-- Hand-written (local Postgres unavailable at author time); applied in prod via
-- `prisma migrate deploy`. Spec: medialane-core/docs/specs/2026-06-17-x402-agent-payments-design.md

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('SETTLED', 'FAILED');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "creditBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amountAtomic" TEXT NOT NULL,
    "creditedAmount" INTEGER NOT NULL,
    "mdlnMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "status" "PaymentStatus" NOT NULL DEFAULT 'SETTLED',
    "txHash" TEXT NOT NULL,
    "proofNonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_proofNonce_key" ON "Payment"("proofNonce");

-- CreateIndex
CREATE INDEX "Payment_tenantId_idx" ON "Payment"("tenantId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
