DROP TABLE "UsageEvent";

BEGIN;
CREATE TEMP TABLE "CreditEntry_kept" ON COMMIT DROP AS
  SELECT * FROM "CreditEntry"
  WHERE "kind" IN ('OPENING', 'PAYMENT', 'GRANT') OR "launchpadRunId" IS NOT NULL;
TRUNCATE "CreditEntry";
INSERT INTO "CreditEntry" SELECT * FROM "CreditEntry_kept";
COMMIT;

ALTER TABLE "CreditEntry" DROP COLUMN "usageEventId";
