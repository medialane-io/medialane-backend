-- An identity belongs to an app. Wallets and emails are unique within an app.
UPDATE "App" SET "name" = 'Medialane' WHERE "id" = 'MEDIALANE_API';

ALTER TABLE "Identity" ALTER COLUMN "appId" SET NOT NULL;
ALTER TABLE "Identity" DROP CONSTRAINT "Identity_appId_fkey";
ALTER TABLE "Identity" ADD CONSTRAINT "Identity_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Identity_appId_chain_address_key" ON "Identity"("appId", "chain", "address");
CREATE UNIQUE INDEX "Identity_appId_scheme_value_key" ON "Identity"("appId", "scheme", "value");

ALTER TABLE "Identity" DROP COLUMN "apiCreditsId";
