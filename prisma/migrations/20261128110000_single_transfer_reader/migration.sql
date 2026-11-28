UPDATE "SourceCursor" AS t
SET "lastBlock" = e."lastBlock", "updatedAt" = CURRENT_TIMESTAMP
FROM "SourceCursor" AS e
WHERE t."chain" = e."chain"
  AND t."sourceId" = 'transfers'
  AND e."sourceId" = 'transfers:external'
  AND e."lastBlock" < t."lastBlock";

DELETE FROM "SourceCursor" WHERE "sourceId" = 'transfers:external';
