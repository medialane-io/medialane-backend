-- AlterTable: Collection — add soft-delete fields
ALTER TABLE "Collection" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "Collection" ADD COLUMN IF NOT EXISTS "deletedBy" TEXT;
