-- Register Ninja zombies (external ERC-721).
-- Idempotent: no-op if the indexer already created the row.
INSERT INTO "Collection" ("id", "chain", "contractAddress", "service", "standard", "startBlock", "metadataStatus", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'STARKNET',
  '0x0554439063d33efe1bc310f9ae16e98f6001fd8ed8eb09ed87e797c142fe4058',
  'external-erc721',
  'ERC721',
  373094,
  'PENDING',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("chain", "contractAddress") DO NOTHING;
