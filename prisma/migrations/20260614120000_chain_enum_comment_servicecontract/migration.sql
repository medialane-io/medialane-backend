-- Multichain readiness (spec 2026-06-13 §3.5): Comment.chain and
-- ServiceContract.chain move from free-form text to the Chain enum so one
-- Chain type is used everywhere.
--
-- PRE-APPLY CHECK (prod): every existing value must upper-case into a valid
-- Chain enum member. Verify before deploy:
--   SELECT DISTINCT chain FROM "Comment";
--   SELECT DISTINCT chain FROM "ServiceContract";
-- Expected: only 'starknet' / 'STARKNET' (castable). Normalize any stragglers
-- first, or this migration will error on the USING cast.

-- Comment.chain: text "starknet" -> Chain enum (default was the lowercase string)
ALTER TABLE "Comment" ALTER COLUMN "chain" DROP DEFAULT;
ALTER TABLE "Comment"
  ALTER COLUMN "chain" TYPE "Chain"
  USING (upper("chain"))::"Chain";
ALTER TABLE "Comment" ALTER COLUMN "chain" SET DEFAULT 'STARKNET';

-- ServiceContract.chain: text -> Chain enum (no default; required)
ALTER TABLE "ServiceContract"
  ALTER COLUMN "chain" TYPE "Chain"
  USING (upper("chain"))::"Chain";
