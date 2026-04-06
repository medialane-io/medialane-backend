-- Add marketplaceContract to Order for protocol-agnostic multi-version history
ALTER TABLE "Order" ADD COLUMN "marketplaceContract" TEXT;
CREATE INDEX "Order_marketplaceContract_idx" ON "Order"("marketplaceContract");
