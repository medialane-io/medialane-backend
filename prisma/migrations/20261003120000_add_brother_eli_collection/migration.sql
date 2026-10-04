-- Manually register Brother Eli (external ERC-721) now that the admin UI is gone.
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x062969ccea9a6740d66f2c9aab3f1466f75c5fe21f28355082e20ace7340a289',
  'external-erc721',
  'ERC721',
  15741851,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;
