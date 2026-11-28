UPDATE "Token"
SET "metadataStatus" = 'PENDING'
WHERE "metadataStatus" = 'FAILED' AND "tokenUri" IS NULL AND "image" IS NULL;
