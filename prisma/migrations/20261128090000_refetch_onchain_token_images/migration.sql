UPDATE "Token"
SET "image" = NULL, "metadataStatus" = 'PENDING'
WHERE "image" LIKE '%/media/starknet/%/image';
