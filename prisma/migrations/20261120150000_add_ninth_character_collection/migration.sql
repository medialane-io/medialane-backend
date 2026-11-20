-- Register Ninth Character (external ERC-721).
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x00701a4015d16941a49b9cc07a6e04f6a38b2f96fba1c1148aebfde99a27819a',
  'external-erc721',
  'ERC721',
  573066,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;
