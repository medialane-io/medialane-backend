-- Drop UNKNOWN from the TokenStandard enum. Prod has zero rows using it (verified
-- after the 2026-05-22 backfill: 113 ERC721 + 13 ERC1155 = 126 rows, 0 UNKNOWN).
-- The phantom value encouraged defensive "?? UNKNOWN" coding that's no longer
-- needed — every collection now has a real standard from the indexer.
--
-- Postgres doesn't allow removing an enum value that any column declares as a
-- default, so we recreate the type and re-cast the column in one step.

ALTER TABLE "Collection" ALTER COLUMN "standard" DROP DEFAULT;
ALTER TYPE "TokenStandard" RENAME TO "TokenStandard_old";
CREATE TYPE "TokenStandard" AS ENUM ('ERC721', 'ERC1155');
ALTER TABLE "Collection"
  ALTER COLUMN "standard" TYPE "TokenStandard"
  USING standard::text::"TokenStandard";
DROP TYPE "TokenStandard_old";
