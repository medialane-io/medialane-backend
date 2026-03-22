-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'starknet',
    "contractAddress" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "txHash" TEXT,
    "blockNumber" BIGINT NOT NULL,
    "blockTimestamp" BIGINT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Comment_txHash_logIndex_key" ON "Comment"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "Comment_chain_contractAddress_tokenId_idx" ON "Comment"("chain", "contractAddress", "tokenId");

-- CreateIndex
CREATE INDEX "Comment_author_idx" ON "Comment"("author");
