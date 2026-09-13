CREATE TABLE "Tenant" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE INDEX "Tenant_slug_idx" ON "Tenant"("slug");

INSERT INTO "Tenant" ("id", "slug", "name") VALUES
  ('tnt_medialane_starknet', 'MEDIALANE_STARKNET', 'Medialane'),
  ('tnt_medialane_io',       'MEDIALANE_IO',       'Medialane.io'),
  ('tnt_medialane_portal',   'MEDIALANE_PORTAL',   'Medialane Portal'),
  ('tnt_medialane_dao',      'MEDIALANE_DAO',      'Medialane DAO'),
  ('tnt_medialane_sdk',      'MEDIALANE_SDK',      'Medialane SDK');

ALTER TABLE "Identity" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "ApiKey"   ADD COLUMN "tenantId" TEXT;

UPDATE "Identity" SET "tenantId" = t."id" FROM "Tenant" t WHERE t."slug" = "Identity"."appSource"::text;
UPDATE "ApiKey"   SET "tenantId" = t."id" FROM "Tenant" t WHERE t."slug" = "ApiKey"."appSource"::text;

ALTER TABLE "Identity" ALTER COLUMN "tenantId" SET NOT NULL;

DROP INDEX "Identity_scheme_value_key";
DROP INDEX "Identity_appSource_idx";
DROP INDEX "ApiKey_appSource_idx";

ALTER TABLE "Identity" DROP COLUMN "appSource";
ALTER TABLE "ApiKey"   DROP COLUMN "appSource";

DROP TYPE "AppSource";

CREATE UNIQUE INDEX "Identity_scheme_value_tenantId_key" ON "Identity"("scheme", "value", "tenantId");
CREATE INDEX "Identity_tenantId_idx" ON "Identity"("tenantId");
CREATE INDEX "ApiKey_tenantId_idx" ON "ApiKey"("tenantId");

ALTER TABLE "Identity" ADD CONSTRAINT "Identity_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
