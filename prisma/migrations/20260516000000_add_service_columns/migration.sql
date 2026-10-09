-- Service-model refactor.
-- Additive only: two open-ended string columns + their indexes. No enum changes,
-- no CONCURRENTLY (safe for `prisma migrate deploy` on Railway). `source` /
-- `marketplaceContract` are intentionally retained (dual-write / explorer link).

ALTER TABLE "Collection" ADD COLUMN "service" TEXT;
ALTER TABLE "Order" ADD COLUMN "marketplaceService" TEXT;

CREATE INDEX "Collection_chain_service_idx" ON "Collection"("chain", "service");
CREATE INDEX "Order_marketplaceService_idx" ON "Order"("marketplaceService");
