-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'COUNTER_OFFERED';

-- AlterEnum
ALTER TYPE "IntentType" ADD VALUE 'COUNTER_OFFER';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "parentOrderHash" TEXT;
ALTER TABLE "Order" ADD COLUMN "counterOfferMessage" TEXT;

-- AlterTable
ALTER TABLE "TransactionIntent" ADD COLUMN "parentOrderHash" TEXT;
ALTER TABLE "TransactionIntent" ADD COLUMN "counterOfferMessage" TEXT;

-- CreateIndex
CREATE INDEX "Order_chain_parentOrderHash_idx" ON "Order"("chain", "parentOrderHash");
