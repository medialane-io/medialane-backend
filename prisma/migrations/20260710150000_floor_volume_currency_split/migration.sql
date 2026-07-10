-- Split the display-formatted stats cache ("1.500000 USDC") into a
-- numeric-only value plus a currency column. Fixes the /v1/collections
-- ?sort=floor|volume 500: `"floorPrice"::numeric` cannot cast a string
-- with a symbol suffix. Display composition moves to the serializer.

ALTER TABLE "Collection" ADD COLUMN "floorCurrency" TEXT;
ALTER TABLE "Collection" ADD COLUMN "volumeCurrency" TEXT;

-- Reshape existing "value SYMBOL" rows.
UPDATE "Collection"
SET "floorCurrency" = split_part("floorPrice", ' ', 2),
    "floorPrice"    = split_part("floorPrice", ' ', 1)
WHERE "floorPrice" LIKE '% %';

UPDATE "Collection"
SET "volumeCurrency" = split_part("totalVolume", ' ', 2),
    "totalVolume"    = split_part("totalVolume", ' ', 1)
WHERE "totalVolume" LIKE '% %';

-- Anything left non-numeric can't be attributed a value; null it — the next
-- STATS_UPDATE recomputes from Orders/OrderFills.
UPDATE "Collection" SET "floorPrice" = NULL, "floorCurrency" = NULL
WHERE "floorPrice" IS NOT NULL AND "floorPrice" !~ '^[0-9]+(\.[0-9]+)?$';

UPDATE "Collection" SET "totalVolume" = NULL, "volumeCurrency" = NULL
WHERE "totalVolume" IS NOT NULL AND "totalVolume" !~ '^[0-9]+(\.[0-9]+)?$';
