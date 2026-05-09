-- Track each marketplace fulfillment separately.
-- ERC-1155 orders can be partially filled many times while the Order row stays ACTIVE.
CREATE TABLE "OrderFill" (
    "id" TEXT NOT NULL,
    "chain" "Chain" NOT NULL DEFAULT 'STARKNET',
    "orderHash" TEXT NOT NULL,
    "fulfiller" TEXT NOT NULL,
    "quantity" TEXT NOT NULL DEFAULT '1',
    "remainingAmount" TEXT,
    "priceRaw" TEXT,
    "priceFormatted" TEXT,
    "currencySymbol" TEXT,
    "currencyToken" TEXT,
    "nftContract" TEXT,
    "nftTokenId" TEXT,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderFill_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderFill_chain_orderHash_txHash_logIndex_key" ON "OrderFill"("chain", "orderHash", "txHash", "logIndex");
CREATE INDEX "OrderFill_chain_orderHash_idx" ON "OrderFill"("chain", "orderHash");
CREATE INDEX "OrderFill_chain_nftContract_idx" ON "OrderFill"("chain", "nftContract");
CREATE INDEX "OrderFill_chain_nftContract_nftTokenId_idx" ON "OrderFill"("chain", "nftContract", "nftTokenId");
CREATE INDEX "OrderFill_createdAt_idx" ON "OrderFill"("createdAt");

ALTER TABLE "OrderFill" ADD CONSTRAINT "OrderFill_chain_orderHash_fkey"
FOREIGN KEY ("chain", "orderHash") REFERENCES "Order"("chain", "orderHash")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve the existing one-row-per-sale minimum for historical data.
-- Older partial ERC-1155 rows did not retain the fill transaction hash, so this
-- backfill intentionally stores one synthetic fill against the order's known tx.
INSERT INTO "OrderFill" (
    "id",
    "chain",
    "orderHash",
    "fulfiller",
    "quantity",
    "remainingAmount",
    "priceRaw",
    "priceFormatted",
    "currencySymbol",
    "currencyToken",
    "nftContract",
    "nftTokenId",
    "txHash",
    "logIndex",
    "blockNumber",
    "createdAt"
)
SELECT
    concat('backfill_', "id"),
    "chain",
    "orderHash",
    "fulfiller",
    '1',
    "remainingAmount",
    "priceRaw",
    "priceFormatted",
    "currencySymbol",
    CASE
      WHEN "offerItemType" = 'ERC20' THEN "offerToken"
      ELSE "considerationToken"
    END,
    "nftContract",
    "nftTokenId",
    COALESCE("fulfilledTxHash", "createdTxHash"),
    0,
    "createdBlockNumber",
    "updatedAt"
FROM "Order"
WHERE "fulfiller" IS NOT NULL
  AND COALESCE("fulfilledTxHash", "createdTxHash") IS NOT NULL
  AND (
    "status" = 'FULFILLED'
    OR (
      "status" = 'ACTIVE'
      AND "remainingAmount" IS NOT NULL
      AND ("offerItemType" = 'ERC1155' OR "considerationItemType" = 'ERC1155')
    )
  )
ON CONFLICT DO NOTHING;
