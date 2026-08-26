-- CreateIndex
CREATE INDEX "Transfer_chain_blockNumber_idx" ON "Transfer"("chain", "blockNumber");

-- CreateIndex
CREATE INDEX "Order_chain_updatedAt_idx" ON "Order"("chain", "updatedAt");
