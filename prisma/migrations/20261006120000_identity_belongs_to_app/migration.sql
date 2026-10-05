-- An identity belongs to an app. Wallets and emails are unique within an app.
-- Identities registered since the previous backfill get their app the same way.
UPDATE "Identity" SET "appId" = CASE encode(sha256(convert_to("apiCreditsId", 'UTF8')), 'hex')
  WHEN '8c899c43482b7502adf7db7c3af8032ac4e1e2606ca92ac941a38c59df72848d' THEN 'MEDIALANE_IO'
  WHEN 'b528a45533f546e15b5005e215c7d7cbdcfc3ad7a843755ef80d147e0db00204' THEN 'MEDIALANE_STARKNET'
  WHEN '9c1751de5446af1977412a7f62953aa50cb02c3a2c16e0fbc64899823fd0aae0' THEN 'MEDIALANE_PORTAL'
  WHEN '13e09de0df168e7e796d989c570b255a89d6e0d9b43a0e2efb131d596472f692' THEN 'MEDIALANE_DAO'
  ELSE 'MEDIALANE_API'
END
WHERE "appId" IS NULL;

UPDATE "App" SET "name" = 'Medialane' WHERE "id" = 'MEDIALANE_API';

ALTER TABLE "Identity" ALTER COLUMN "appId" SET NOT NULL;
ALTER TABLE "Identity" DROP CONSTRAINT "Identity_appId_fkey";
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Identity_appId_chain_address_key" ON "Identity"("appId", "chain", "address");
CREATE UNIQUE INDEX "Identity_appId_scheme_value_key" ON "Identity"("appId", "scheme", "value");

ALTER TABLE "Identity" DROP COLUMN "apiCreditsId";
