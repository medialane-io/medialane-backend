-- Register CoolFellas (external ERC-721).
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x07feff50d156cc0a44098a74d9747c35ff12e0a3b2b3fd248f37c676112ac1fb',
  'external-erc721',
  'ERC721',
  6313,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;
