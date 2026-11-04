-- Register Stark Creepz (external ERC-721).
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x01848c9866e8577f76e221c87ed85cf6a79371fcd4d37dbc0a42f27d62db1c13',
  'external-erc721',
  'ERC721',
  384644,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;
