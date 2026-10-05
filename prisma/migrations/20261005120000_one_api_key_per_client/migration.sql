-- Keys that were revoked no longer work and are not kept.
DELETE FROM "ApiKey" WHERE "status" = 'REVOKED';

-- A client keeps one key: the one used most recently, else the newest.
DELETE FROM "ApiKey" k
USING (
  SELECT "id", ROW_NUMBER() OVER (
    PARTITION BY "apiClientId"
    ORDER BY "lastUsedAt" DESC NULLS LAST, "createdAt" DESC
  ) AS "rank"
  FROM "ApiKey"
) ranked
WHERE k."id" = ranked."id" AND ranked."rank" > 1;

-- DropIndex
DROP INDEX "ApiKey_apiClientId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_apiClientId_key" ON "ApiKey"("apiClientId");
