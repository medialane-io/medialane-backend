-- Phase 2D.4 (irreversible): drop the legacy Collection.source column and the
-- CollectionSource enum. The service-model migration is complete — `service`
-- (String?) is now the sole collection categorization field. Verified safe via
-- /admin/collections/service-coverage: missingService = 0 (no non-external
-- collection lacks a service).
--
-- Order matters: the column must be dropped before the enum type it uses.
ALTER TABLE "Collection" DROP COLUMN "source";
DROP TYPE "CollectionSource";
