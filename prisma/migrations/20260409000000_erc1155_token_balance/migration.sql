-- ERC-1155 Phase 1a: Add TokenStandard enum, TokenBalance table,
-- Collection.standard field, Transfer.amount field.
-- Token.owner is retained here and removed in Phase 1b migration
-- after the indexer is live and writing to TokenBalance.

-- 1. New TokenStandard enum
CREATE TYPE "TokenStandard" AS ENUM ('ERC721', 'ERC1155', 'UNKNOWN');

-- 2. Add standard to Collection (default UNKNOWN — backfilled by metadata fetcher)
ALTER TABLE "Collection" ADD COLUMN "standard" "TokenStandard" NOT NULL DEFAULT 'UNKNOWN';

-- 3. Add amount to Transfer (default "1" for all existing ERC-721 rows)
ALTER TABLE "Transfer" ADD COLUMN "amount" TEXT NOT NULL DEFAULT '1';

-- 4. Create TokenBalance table
CREATE TABLE "TokenBalance" (
  "id"              TEXT NOT NULL,
  "chain"           "Chain" NOT NULL DEFAULT 'STARKNET',
  "contractAddress" TEXT NOT NULL,
  "tokenId"         TEXT NOT NULL,
  "owner"           TEXT NOT NULL,
  "amount"          TEXT NOT NULL,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TokenBalance_pkey" PRIMARY KEY ("id")
);

-- Unique: one balance row per (chain, contract, tokenId, owner)
CREATE UNIQUE INDEX "TokenBalance_chain_contractAddress_tokenId_owner_key"
  ON "TokenBalance"("chain", "contractAddress", "tokenId", "owner");

-- Indexes for common query patterns
CREATE INDEX "TokenBalance_chain_owner_idx"
  ON "TokenBalance"("chain", "owner");

CREATE INDEX "TokenBalance_chain_contractAddress_idx"
  ON "TokenBalance"("chain", "contractAddress");

CREATE INDEX "TokenBalance_chain_contractAddress_tokenId_idx"
  ON "TokenBalance"("chain", "contractAddress", "tokenId");
