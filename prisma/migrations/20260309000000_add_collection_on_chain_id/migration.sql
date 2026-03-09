-- Add on-chain collectionId to Collection (nullable, existing rows unaffected)
ALTER TABLE "Collection" ADD COLUMN IF NOT EXISTS "collectionId" TEXT;
