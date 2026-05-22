-- Make Collection.service NOT NULL.
--
-- Prod has zero null rows after the legacy-to-external backfill on 2026-05-22:
-- every collection now carries an explicit service value (mip-erc721,
-- mip-erc1155, external-erc721, external-erc1155, etc.). The DB-level
-- constraint locks this in so the source-of-null bugs we patched today
-- (claims.ts, admin/collections.ts, orchestrator/collectionMetadata.ts) can
-- never silently re-introduce nulls — any future write of NULL fails loudly.

ALTER TABLE "Collection" ALTER COLUMN "service" SET NOT NULL;
