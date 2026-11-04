-- Identity and ApiKey keep replaced rows with a status instead of deleting them.
CREATE TYPE "IdentityStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

ALTER TABLE "Identity" ADD COLUMN "status" "IdentityStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "ApiKey" ADD COLUMN "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE';

-- A released notice claim is kept as RELEASED and can be claimed again.
CREATE TYPE "NoticeStatus" AS ENUM ('CLAIMED', 'RELEASED');
ALTER TABLE "AccountNotice" ADD COLUMN "status" "NoticeStatus" NOT NULL DEFAULT 'CLAIMED';

-- One ACTIVE identity per (accountId, scheme); INACTIVE rows are kept alongside it.
CREATE UNIQUE INDEX "Identity_accountId_scheme_active_key" ON "Identity"("accountId", "scheme") WHERE "status" = 'ACTIVE';
CREATE INDEX "Identity_accountId_scheme_idx" ON "Identity"("accountId", "scheme");
DROP INDEX "Identity_accountId_scheme_key";

-- One ACTIVE key per ApiCredits; REVOKED keys are kept alongside it.
CREATE UNIQUE INDEX "ApiKey_apiCreditsId_active_key" ON "ApiKey"("apiCreditsId") WHERE "status" = 'ACTIVE';
CREATE INDEX "ApiKey_apiCreditsId_idx" ON "ApiKey"("apiCreditsId");
DROP INDEX "ApiKey_apiCreditsId_key";

-- Relations between record tables restrict instead of cascading.
ALTER TABLE "AccountNotice" DROP CONSTRAINT "AccountNotice_accountId_fkey";
ALTER TABLE "AccountNotice" ADD CONSTRAINT "AccountNotice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountProfile" DROP CONSTRAINT "AccountProfile_accountId_fkey";
ALTER TABLE "AccountProfile" ADD CONSTRAINT "AccountProfile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApiCredits" DROP CONSTRAINT "ApiCredits_accountId_fkey";
ALTER TABLE "ApiCredits" ADD CONSTRAINT "ApiCredits_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Identity" DROP CONSTRAINT "Identity_accountId_fkey";
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApiKey" DROP CONSTRAINT "ApiKey_apiCreditsId_fkey";
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_apiCreditsId_fkey" FOREIGN KEY ("apiCreditsId") REFERENCES "ApiCredits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_apiCreditsId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_apiCreditsId_fkey" FOREIGN KEY ("apiCreditsId") REFERENCES "ApiCredits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_fundingIntentId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_fundingIntentId_fkey" FOREIGN KEY ("fundingIntentId") REFERENCES "FundingIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FundingIntent" DROP CONSTRAINT "FundingIntent_apiCreditsId_fkey";
ALTER TABLE "FundingIntent" ADD CONSTRAINT "FundingIntent_apiCreditsId_fkey" FOREIGN KEY ("apiCreditsId") REFERENCES "ApiCredits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LaunchpadRun" DROP CONSTRAINT "LaunchpadRun_apiCreditsId_fkey";
ALTER TABLE "LaunchpadRun" ADD CONSTRAINT "LaunchpadRun_apiCreditsId_fkey" FOREIGN KEY ("apiCreditsId") REFERENCES "ApiCredits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditEntry" DROP CONSTRAINT "CreditEntry_apiCreditsId_fkey";
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_apiCreditsId_fkey" FOREIGN KEY ("apiCreditsId") REFERENCES "ApiCredits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Record tables refuse DELETE (row trigger) and TRUNCATE (statement trigger; row triggers do not fire on TRUNCATE).
CREATE FUNCTION "refuse_record_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
END
$$ LANGUAGE plpgsql;

-- Guards one record table. A new record table calls it in the migration that creates the table.
CREATE FUNCTION "guard_record_table"(t text) RETURNS void AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "refuse_record_delete"()', t || '_no_delete', t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "refuse_record_delete"()', t || '_no_truncate', t);
END
$$ LANGUAGE plpgsql;

SELECT "guard_record_table"('Account');
SELECT "guard_record_table"('Identity');
SELECT "guard_record_table"('AccountProfile');
SELECT "guard_record_table"('AccountEvent');
SELECT "guard_record_table"('AccountNotice');
SELECT "guard_record_table"('App');
SELECT "guard_record_table"('ApiCredits');
SELECT "guard_record_table"('ApiKey');
SELECT "guard_record_table"('CreditEntry');
SELECT "guard_record_table"('Payment');
SELECT "guard_record_table"('FundingIntent');
SELECT "guard_record_table"('LaunchpadRun');
SELECT "guard_record_table"('TransactionIntent');
SELECT "guard_record_table"('Comment');
SELECT "guard_record_table"('Report');
SELECT "guard_record_table"('RemixOffer');
SELECT "guard_record_table"('UsernameClaim');
SELECT "guard_record_table"('CollectionSlugClaim');
SELECT "guard_record_table"('CollectionClaim');
SELECT "guard_record_table"('CollectionProfile');
SELECT "guard_record_table"('HiddenCreator');
