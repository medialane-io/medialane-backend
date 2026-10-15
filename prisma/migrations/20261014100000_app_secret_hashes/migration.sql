-- AlterTable
ALTER TABLE "App" ADD COLUMN     "secretHashes" TEXT[] DEFAULT ARRAY[]::TEXT[];
