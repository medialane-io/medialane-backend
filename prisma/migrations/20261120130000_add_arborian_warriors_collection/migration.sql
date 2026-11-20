-- Register Arborian Warriors (external ERC-721).
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x0146a5f4f47d589951b6a3cb933147a081e6e4d3d40371a2df7477c476c2756e',
  'external-erc721',
  'ERC721',
  355285,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;
