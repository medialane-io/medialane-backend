-- Email verification timestamps are not kept for any account.
ALTER TABLE "Identity" DROP COLUMN "verifiedAt";

-- The welcome email no longer exists; remove its sent-markers.
DELETE FROM "AccountNotice" WHERE "kind" = 'welcome';
