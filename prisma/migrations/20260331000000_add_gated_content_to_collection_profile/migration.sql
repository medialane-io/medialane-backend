-- AddColumn to CollectionProfile for token-gated content
ALTER TABLE "CollectionProfile" ADD COLUMN "gatedContentTitle" TEXT;
ALTER TABLE "CollectionProfile" ADD COLUMN "gatedContentUrl" TEXT;
ALTER TABLE "CollectionProfile" ADD COLUMN "gatedContentType" TEXT;
ALTER TABLE "CollectionProfile" ADD COLUMN "hasGatedContent" BOOLEAN NOT NULL DEFAULT false;
