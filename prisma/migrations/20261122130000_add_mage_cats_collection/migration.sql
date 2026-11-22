-- Register Mage Cats (external ERC-721).
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x07d74935a915f3551bc0ce992aa0dd46d5e7606d0607a4cacc532da675f431b7',
  'external-erc721',
  'ERC721',
  169561,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;
