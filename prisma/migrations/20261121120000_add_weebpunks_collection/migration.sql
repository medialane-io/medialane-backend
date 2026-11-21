-- Register WeebPunks (external ERC-721).
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x0507e93cecf4e2b5b5cc6a9131db8dffb17f32a8c7bd5fe1011baa290ed7dcbb',
  'external-erc721',
  'ERC721',
  575000,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;
