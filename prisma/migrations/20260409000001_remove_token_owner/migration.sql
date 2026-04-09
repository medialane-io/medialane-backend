-- Phase 1b: Remove Token.owner column now that TokenBalance is the canonical ownership source.
-- TokenBalance (written by Phase 1a indexer) handles both ERC-721 and ERC-1155.

DROP INDEX IF EXISTS "Token_chain_owner_idx";
ALTER TABLE "Token" DROP COLUMN IF EXISTS "owner";
