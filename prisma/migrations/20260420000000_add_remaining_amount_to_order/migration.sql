-- Add remainingAmount to Order for ERC-1155 partial fill tracking.
-- Null = ERC-721 order or ERC-1155 order not yet partially filled.
-- Non-null = ERC-1155 order with known remaining units after at least one partial fill.
ALTER TABLE "Order" ADD COLUMN "remainingAmount" TEXT;
