-- Add owner column to Collection
ALTER TABLE "Collection" ADD COLUMN IF NOT EXISTS "owner" TEXT;
