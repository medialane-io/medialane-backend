ALTER TABLE "Identity" ADD COLUMN "clientId" TEXT;
ALTER TABLE "Identity" ALTER COLUMN "tenantId" DROP NOT NULL;

UPDATE "Identity" i
SET "clientId" = m.client_id
FROM "Tenant" t
JOIN (VALUES
  ('MEDIALANE_IO', 'cmsgntzmi0005zhvezbu328xo'),
  ('MEDIALANE_STARKNET', 'cmsgnu3ip0007zhvebh71knj6'),
  ('MEDIALANE_PORTAL', 'cmsgntvzo0003zhvezn59men6'),
  ('MEDIALANE_DAO', 'cmsgnue62000dzhve2cg7nhnz')
) AS m(slug, client_id) ON m.slug = t.slug
JOIN "ApiClient" c ON c.id = m.client_id
WHERE i."tenantId" = t.id;

ALTER TABLE "Identity" ADD CONSTRAINT "Identity_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Identity_clientId_chain_address_key" ON "Identity"("clientId", "chain", "address");
CREATE UNIQUE INDEX "Identity_clientId_scheme_value_key" ON "Identity"("clientId", "scheme", "value");
CREATE INDEX "Identity_clientId_idx" ON "Identity"("clientId");
DROP INDEX "Identity_chain_address_key";

INSERT INTO "AccountProfile" ("id", "accountId", "name", "createdAt", "updatedAt")
SELECT 'prof_' || c.id, c."accountId", m.name, now(), now()
FROM (VALUES
  ('cmsgntzmi0005zhvezbu328xo', 'Medialane.io'),
  ('cmsgnu3ip0007zhvebh71knj6', 'Medialane'),
  ('cmsgntvzo0003zhvezn59men6', 'Medialane Portal'),
  ('cmsgnue62000dzhve2cg7nhnz', 'Medialane DAO')
) AS m(client_id, name)
JOIN "ApiClient" c ON c.id = m.client_id
ON CONFLICT ("accountId") DO UPDATE SET "name" = COALESCE("AccountProfile"."name", EXCLUDED."name"), "updatedAt" = now();
