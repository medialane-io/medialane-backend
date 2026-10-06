-- DropIndex
DROP INDEX "Order_chain_status_idx";

-- DropIndex
DROP INDEX "OrderFill_chain_orderHash_idx";

-- DropIndex
DROP INDEX "OrderFill_chain_nftContract_idx";

-- DropIndex
DROP INDEX "Token_chain_contractAddress_idx";

-- DropIndex
DROP INDEX "Token_chain_isHidden_idx";

-- DropIndex
DROP INDEX "TokenBalance_chain_contractAddress_idx";

-- DropIndex
DROP INDEX "TokenBalance_chain_contractAddress_tokenId_idx";

-- DropIndex
DROP INDEX "Identity_appId_idx";

-- DropIndex
DROP INDEX "Identity_accountId_idx";

-- DropIndex
DROP INDEX "PricingRule_actionKey_idx";

-- DropIndex
DROP INDEX "UserBadge_address_idx";

-- AlterTable
ALTER TABLE "IndexerCursor" DROP COLUMN "continuationToken";

-- CreateIndex
CREATE INDEX "Order_chain_fulfiller_idx" ON "Order"("chain", "fulfiller");

-- CreateIndex
CREATE INDEX "Token_chain_isHidden_metadataStatus_createdAt_idx" ON "Token"("chain", "isHidden", "metadataStatus", "createdAt");

-- CreateIndex
CREATE INDEX "Transfer_chain_createdAt_idx" ON "Transfer"("chain", "createdAt");

