-- CreateEnum
CREATE TYPE "Chain" AS ENUM ('STARKNET', 'ETHEREUM', 'SOLANA', 'BITCOIN');

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_nftContract_nftTokenId_fkey";

-- DropForeignKey
ALTER TABLE "Token" DROP CONSTRAINT "Token_contractAddress_fkey";

-- DropForeignKey
ALTER TABLE "Transfer" DROP CONSTRAINT "Transfer_contractAddress_tokenId_fkey";

-- DropIndex
DROP INDEX "Collection_contractAddress_key";

-- DropIndex
DROP INDEX "Order_nftContract_nftTokenId_idx";

-- DropIndex
DROP INDEX "Order_offerer_idx";

-- DropIndex
DROP INDEX "Order_orderHash_key";

-- DropIndex
DROP INDEX "Order_status_idx";

-- DropIndex
DROP INDEX "Token_contractAddress_idx";

-- DropIndex
DROP INDEX "Token_contractAddress_tokenId_key";

-- DropIndex
DROP INDEX "Token_owner_idx";

-- DropIndex
DROP INDEX "TransactionIntent_requester_idx";

-- DropIndex
DROP INDEX "TransactionIntent_status_idx";

-- DropIndex
DROP INDEX "Transfer_contractAddress_tokenId_idx";

-- DropIndex
DROP INDEX "Transfer_fromAddress_idx";

-- DropIndex
DROP INDEX "Transfer_toAddress_idx";

-- DropIndex
DROP INDEX "Transfer_txHash_logIndex_key";

-- AlterTable: Collection — add chain with default
ALTER TABLE "Collection" ADD COLUMN "chain" "Chain" NOT NULL DEFAULT 'STARKNET';

-- AlterTable: IndexerCursor — add chain with default, promote to PK, drop old id
ALTER TABLE "IndexerCursor" ADD COLUMN "chain" "Chain" NOT NULL DEFAULT 'STARKNET';
ALTER TABLE "IndexerCursor" DROP CONSTRAINT "IndexerCursor_pkey";
ALTER TABLE "IndexerCursor" DROP COLUMN "id";
ALTER TABLE "IndexerCursor" ADD CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("chain");

-- AlterTable: Order — add chain with default
ALTER TABLE "Order" ADD COLUMN "chain" "Chain" NOT NULL DEFAULT 'STARKNET';

-- AlterTable: Token — add chain with default
ALTER TABLE "Token" ADD COLUMN "chain" "Chain" NOT NULL DEFAULT 'STARKNET';

-- AlterTable: TransactionIntent — add chain with default
ALTER TABLE "TransactionIntent" ADD COLUMN "chain" "Chain" NOT NULL DEFAULT 'STARKNET';

-- AlterTable: Transfer — add chain with default
ALTER TABLE "Transfer" ADD COLUMN "chain" "Chain" NOT NULL DEFAULT 'STARKNET';

-- CreateIndex
CREATE UNIQUE INDEX "Collection_chain_contractAddress_key" ON "Collection"("chain", "contractAddress");

-- CreateIndex
CREATE INDEX "Order_chain_offerer_idx" ON "Order"("chain", "offerer");

-- CreateIndex
CREATE INDEX "Order_chain_status_idx" ON "Order"("chain", "status");

-- CreateIndex
CREATE INDEX "Order_chain_nftContract_nftTokenId_idx" ON "Order"("chain", "nftContract", "nftTokenId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_chain_orderHash_key" ON "Order"("chain", "orderHash");

-- CreateIndex
CREATE INDEX "Token_chain_owner_idx" ON "Token"("chain", "owner");

-- CreateIndex
CREATE INDEX "Token_chain_contractAddress_idx" ON "Token"("chain", "contractAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Token_chain_contractAddress_tokenId_key" ON "Token"("chain", "contractAddress", "tokenId");

-- CreateIndex
CREATE INDEX "TransactionIntent_chain_requester_idx" ON "TransactionIntent"("chain", "requester");

-- CreateIndex
CREATE INDEX "TransactionIntent_chain_status_idx" ON "TransactionIntent"("chain", "status");

-- CreateIndex
CREATE INDEX "Transfer_chain_contractAddress_tokenId_idx" ON "Transfer"("chain", "contractAddress", "tokenId");

-- CreateIndex
CREATE INDEX "Transfer_chain_toAddress_idx" ON "Transfer"("chain", "toAddress");

-- CreateIndex
CREATE INDEX "Transfer_chain_fromAddress_idx" ON "Transfer"("chain", "fromAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_chain_txHash_logIndex_key" ON "Transfer"("chain", "txHash", "logIndex");

-- AddForeignKey
ALTER TABLE "Token" ADD CONSTRAINT "Token_chain_contractAddress_fkey" FOREIGN KEY ("chain", "contractAddress") REFERENCES "Collection"("chain", "contractAddress") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_chain_contractAddress_tokenId_fkey" FOREIGN KEY ("chain", "contractAddress", "tokenId") REFERENCES "Token"("chain", "contractAddress", "tokenId") ON DELETE RESTRICT ON UPDATE CASCADE;
