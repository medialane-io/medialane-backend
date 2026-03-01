-- AlterTable
ALTER TABLE "IndexerCursor" ALTER COLUMN "chain" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "offerItemType" SET DATA TYPE TEXT,
ALTER COLUMN "considerationItemType" SET DATA TYPE TEXT;
