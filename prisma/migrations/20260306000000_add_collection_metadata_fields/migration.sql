-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'COLLECTION_METADATA_FETCH';

-- AlterTable
ALTER TABLE "Collection"
  ADD COLUMN "symbol"         TEXT,
  ADD COLUMN "description"    TEXT,
  ADD COLUMN "image"          TEXT,
  ADD COLUMN "baseUri"        TEXT,
  ADD COLUMN "metadataStatus" "MetadataStatus" NOT NULL DEFAULT 'PENDING';
