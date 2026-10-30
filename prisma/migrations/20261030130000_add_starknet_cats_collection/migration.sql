-- Register Starknet Cats (external ERC-721).
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x045a4c4557cb7be24d6c2ba70fa8439307ee855cc69f9d80001727f1871b57bd',
  'external-erc721',
  'ERC721',
  501442,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;
