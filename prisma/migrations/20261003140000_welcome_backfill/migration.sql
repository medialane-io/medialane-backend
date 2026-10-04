-- Record the welcome email as already sent for every account that has a wallet today, so that moving
-- the welcome email onto the notice ledger does not email anyone retroactively.
INSERT INTO "AccountNotice" ("id", "accountId", "kind", "createdAt")
SELECT gen_random_uuid()::text, a."id", 'welcome', CURRENT_TIMESTAMP
FROM "Account" a
WHERE EXISTS (
  SELECT 1 FROM "Identity" w WHERE w."accountId" = a."id" AND w."scheme" = 'wallet'
)
ON CONFLICT ("accountId", "kind") DO NOTHING;
