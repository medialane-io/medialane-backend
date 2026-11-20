-- Register Psilocybins (external ERC-721).
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x0097044cb17f0a5f069193404e91e0bfc0cf917194955fac8131e4cc5aea35e5',
  'external-erc721',
  'ERC721',
  111207,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;
